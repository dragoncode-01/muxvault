import "@fontsource-variable/manrope";
import "./style.css";
import { Asset, Networks, StrKey, rpc } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { formatAssetUnits, parseAssetUnits, parseU64 } from "../../packages/sdk-ts/src/amount.ts";
import { VaultClient } from "../../packages/sdk-ts/src/client.ts";
import { RejectedTransaction, submit, transactionHash, transactionResult } from "../../packages/sdk-ts/src/transactions.ts";
import type { Health, Subaccount } from "../../packages/sdk-ts/src/types.ts";
import { authorizationAddress } from "../../packages/sdk-ts/src/w-address.ts";
import { connectFreighter, createDemoWallet, fundTestnetWallet, isFunded } from "./wallet.ts";
import type { Wallet } from "./wallet.ts";

type Mode = "deposit" | "withdraw";
type Action = "register" | Mode;
type Panel = "funds" | "wallet";
type Submission = Awaited<ReturnType<typeof submit>>;
type Pending = { hash: string; action: Action; amount: string; deadline: number };
type Activity = { hash: string; action: Action; amount: string; ledger: number };
type Settings = { vault: string; readAccount: string; rpcUrl: string };

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`Missing UI element ${id}`);
  return target as T;
}

const ui = {
  nav: element<HTMLButtonElement>("nav-wallet"), navLabel: element("nav-wallet-label"),
  start: element<HTMLButtonElement>("hero-start"), explorer: element<HTMLAnchorElement>("explorer-link"),
  dot: element("network-dot"), reserve: element("reserve"), liabilities: element("liabilities"),
  balance: element("customer-balance"), caption: element("customer-caption"),
  coverage: element("coverage"), coverageLabel: element("coverage-label"),
  segment: element("segmented"), deposit: element<HTMLButtonElement>("deposit-tab"),
  withdraw: element<HTMLButtonElement>("withdraw-tab"), max: element<HTMLButtonElement>("preset-max"), fundsForm: element<HTMLFormElement>("funds-form"),
  amount: element<HTMLInputElement>("amount"), amountHint: element("amount-hint"),
  recipientField: element("recipient-field"), recipient: element<HTMLInputElement>("recipient"),
  action: element<HTMLButtonElement>("funds-action"), actionLabel: element("funds-action-label"),
  fundsStatus: element("funds-status"), walletStatus: element("wallet-status"),
  walletPanel: element("wallet"), fundsPanel: element("funds"),
  walletEmpty: element("wallet-empty"), walletReady: element("wallet-ready"),
  create: element<HTMLButtonElement>("create-wallet"), freighter: element<HTMLButtonElement>("connect-freighter"),
  walletKind: element("wallet-kind"), walletAddress: element("wallet-address"), walletNote: element("wallet-note"),
  disconnect: element<HTMLButtonElement>("disconnect-wallet"), fund: element<HTMLButtonElement>("fund-wallet"),
  copyWallet: element<HTMLButtonElement>("copy-wallet"), copyVault: element<HTMLButtonElement>("copy-vault"),
  vault: element("vault-address"), accountDetails: element<HTMLDetailsElement>("load-account"),
  accountForm: element<HTMLFormElement>("account-form"), accountId: element<HTMLInputElement>("account-id"),
  loadId: element<HTMLButtonElement>("load-id"), refresh: element<HTMLButtonElement>("refresh"),
  emptyActivity: element("activity-empty"), activity: element("activity-list"), toast: element("toast"),
};
const presets = [...document.querySelectorAll<HTMLButtonElement>(".preset[data-value]")];
const explorer = "https://stellar.expert/explorer/testnet";
const actionNames = { register: "Subaccount opened", deposit: "Deposit", withdraw: "Withdrawal" };
const actions: Action[] = ["register", "deposit", "withdraw"];

let client: VaultClient | null = null;
let settings: Settings | null = null;
let wallet: Wallet | null = null;
let funded = false;
let customerId: bigint | null = null;
let subaccount: Subaccount | null = null;
let health: Health | null = null;
let mode: Mode = "deposit";
let busy: Panel | null = null;
let pending: Pending | null = null;
let activities: Activity[] = [];
let toastTimer = 0;

function message(panel: Panel, value = "", kind = "info", hash?: string) {
  const target = panel === "wallet" ? ui.walletStatus : ui.fundsStatus;
  target.hidden = !value;
  target.dataset.kind = kind;
  target.textContent = value;
  if (hash) target.append(transactionLink(hash, "View transaction ↗"));
}

function transactionLink(hash: string, label: string) {
  const link = document.createElement("a");
  link.href = `${explorer}/tx/${hash}`;
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function shorten(address: string) {
  return `${address.slice(0, 7)}…${address.slice(-5)}`;
}

function displayAmount(amount: bigint) {
  const whole = amount / 10_000_000n;
  const fraction = (amount % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${fraction}`;
}

function metric(target: HTMLElement, amount?: bigint) {
  target.textContent = amount === undefined ? "—" : displayAmount(amount);
  if (amount === undefined) return;
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = "XLM";
  target.append(unit);
}

function storageKey(suffix: string) {
  return `muxvault:v1:${settings?.vault ?? "unconfigured"}:${suffix}`;
}

function getStored(suffix: string): unknown {
  try { return JSON.parse(localStorage.getItem(storageKey(suffix)) ?? "null"); }
  catch { return null; }
}

function setStored(suffix: string, value: unknown) {
  try { localStorage.setItem(storageKey(suffix), JSON.stringify(value)); }
  catch { /* The current session can continue with browser storage disabled. */ }
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validActivity(value: unknown): value is Activity {
  if (!value || typeof value !== "object") return false;
  const entry = value as Activity;
  return validHash(entry.hash) && actions.includes(entry.action)
    && typeof entry.amount === "string" && /^\d{1,39}$/.test(entry.amount)
    && Number.isSafeInteger(entry.ledger) && entry.ledger > 0;
}

function showActivity() {
  ui.emptyActivity.hidden = activities.length > 0;
  ui.activity.hidden = activities.length === 0;
  ui.activity.replaceChildren(...activities.map((entry) => {
    const row = document.createElement("li");
    row.className = "activity-row";
    const title = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = actionNames[entry.action];
    const meta = document.createElement("span");
    meta.className = "activity-meta";
    meta.textContent = `CONFIRMED · LEDGER ${entry.ledger}`;
    title.append(name, meta);
    const amount = document.createElement("span");
    amount.className = "activity-amount";
    amount.textContent = entry.action === "register" ? "—"
      : `${entry.action === "deposit" ? "+" : "−"}${displayAmount(BigInt(entry.amount))} XLM`;
    row.append(title, amount, transactionLink(entry.hash, "Explorer ↗"));
    return row;
  }));
}

function render() {
  const locked = busy !== null;
  const signedIn = wallet !== null;
  const ready = subaccount?.active === true;
  ui.walletEmpty.hidden = signedIn;
  ui.walletReady.hidden = !signedIn;
  ui.accountDetails.hidden = !signedIn || !funded;
  ui.create.disabled = locked || !client;
  ui.freighter.disabled = locked || !client;
  ui.disconnect.disabled = locked;
  ui.fund.hidden = funded;
  ui.fund.disabled = locked;
  ui.loadId.disabled = locked || pending !== null;
  ui.refresh.disabled = locked;
  ui.deposit.disabled = locked;
  ui.withdraw.disabled = locked;
  ui.recipient.disabled = locked;
  ui.amount.disabled = locked;
  for (const button of presets) button.disabled = locked;
  ui.max.hidden = mode !== "withdraw" || !ready;
  ui.max.disabled = locked || !subaccount || subaccount.balance === 0n;
  ui.navLabel.textContent = wallet ? shorten(wallet.address) : "Connect wallet";

  if (wallet) {
    ui.walletKind.textContent = wallet.kind === "demo" ? "Demo wallet" : "Freighter wallet";
    ui.walletAddress.textContent = shorten(wallet.address);
    ui.walletAddress.title = wallet.address;
    ui.walletNote.textContent = wallet.kind === "demo"
      ? "The demo key lives in this tab. Keep it open to withdraw your test funds."
      : funded ? "Your transactions are signed in Freighter." : "Fund this address before opening a subaccount.";
  }

  ui.dot.dataset.status = health ? "online" : client || busy ? "checking" : "offline";
  ui.coverage.dataset.status = health ? (health.healthy && !health.paused ? "good" : "bad") : "checking";
  ui.coverageLabel.textContent = health
    ? health.paused ? "Vault paused" : health.healthy ? "Reserve covers liabilities" : "Reserve unavailable"
    : client || busy ? "Checking reserve" : "Connection unavailable";
  metric(ui.balance, subaccount?.balance);
  metric(ui.reserve, health?.reserve);
  metric(ui.liabilities, health?.liabilities);
  ui.caption.textContent = ready ? `Subaccount #${customerId}` : signedIn ? "Open a subaccount below" : "Connect to get started";

  ui.segment.dataset.mode = mode;
  ui.deposit.setAttribute("aria-pressed", String(mode === "deposit"));
  ui.withdraw.setAttribute("aria-pressed", String(mode === "withdraw"));
  ui.recipientField.hidden = mode !== "withdraw";
  ui.amountHint.textContent = mode === "withdraw" && subaccount
    ? `${displayAmount(subaccount.balance)} XLM available` : "Testnet XLM";
  ui.action.disabled = locked || !client || (ready && !!health && (!health.healthy || health.paused));
  ui.action.setAttribute("aria-busy", String(busy === "funds"));
  ui.actionLabel.textContent = busy === "funds" ? "Processing transaction"
    : !signedIn ? "Connect wallet to continue"
    : pending ? "Check pending transaction"
    : !funded ? "Fund wallet with Friendbot"
    : !ready ? "Open subaccount"
    : mode === "deposit" ? "Deposit XLM" : "Withdraw XLM";
}

function showPanel(panel: Panel) {
  const target = panel === "wallet" ? ui.walletPanel : ui.fundsPanel;
  target.scrollIntoView({ block: "nearest" });
  const button = panel === "funds" ? ui.action : wallet ? ui.copyWallet : ui.create;
  button.focus({ preventScroll: true });
}

function notice(text: string) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, 2_900);
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    notice("Address copied");
  } catch {
    notice("Clipboard unavailable. Select and copy the address in its tooltip.");
  }
}

function friendly(error: unknown) {
  if (!(error instanceof Error)) return "The request could not finish. Please try again.";
  if (/no account|does not exist/i.test(error.message)) return "Fund your Testnet wallet before trying again.";
  if (/insufficient balance/i.test(error.message)) return "The wallet or subaccount has insufficient XLM.";
  if (/simulation failed|transaction simulation|timeout of|failed to fetch/i.test(error.message)) {
    return "Stellar RPC could not complete the request. Check your wallet balance or refresh and try again.";
  }
  return error.message;
}

async function run(panel: Panel, status: string, task: () => Promise<void>) {
  if (busy) return;
  busy = panel;
  message(panel, status, "pending");
  render();
  try { await task(); }
  catch (error) { message(panel, friendly(error), "error"); }
  finally { busy = null; render(); }
}

function currentClient(): VaultClient {
  if (!client) throw new Error("Vault configuration is unavailable. Refresh to reconnect.");
  return client;
}

async function updateBalances() {
  if (!settings) return;
  const vault = currentClient();
  const [latest, account] = await Promise.all([
    vault.health(settings.readAccount),
    customerId === null ? Promise.resolve(null) : vault.subaccount(settings.readAccount, customerId),
  ]);
  health = latest;
  subaccount = account && account.owner === wallet?.address && account.active ? account : null;
}

async function loadId(id: bigint) {
  if (!wallet || !settings) return;
  const account = await currentClient().subaccount(settings.readAccount, id);
  if (!account?.active || account.owner !== wallet.address) {
    throw new Error("This subaccount is inactive or belongs to another wallet.");
  }
  customerId = id;
  subaccount = account;
  setStored(`account:${wallet.address}`, id.toString());
}

function savePending(record: Pending | null) {
  pending = record;
  if (wallet) setStored(`pending:${wallet.address}`, record);
}

async function attach(next: Wallet) {
  wallet = next;
  funded = false;
  customerId = null;
  subaccount = null;
  pending = null;
  ui.recipient.value = "";
  ui.accountId.value = "";
  ui.accountDetails.open = false;
  const saved = getStored(`pending:${next.address}`) as Pending | null;
  if (saved && validHash(saved.hash) && actions.includes(saved.action)
    && /^\d{1,39}$/.test(saved.amount) && Number.isFinite(saved.deadline)) pending = saved;
  render();
  funded = await isFunded(currentClient(), next.address);
  const id = getStored(`account:${next.address}`);
  if (funded && typeof id === "string") {
    try { await loadId(parseU64(id)); }
    catch { message("funds", "Use your subaccount ID to load your balance."); }
  }
}

async function fundCurrent() {
  if (!wallet) return;
  await fundTestnetWallet(currentClient(), wallet.address);
  funded = true;
  message("wallet", "Your wallet is funded on Testnet.");
}

async function connected(kind: Wallet["kind"]) {
  await run("wallet", kind === "demo" ? "Creating your Testnet wallet…" : "Waiting for Freighter…", async () => {
    await currentClient().verifyNetwork(30);
    await attach(kind === "demo" ? createDemoWallet() : await connectFreighter());
    if (kind === "demo") {
      message("wallet", "Funding your demo wallet with Friendbot…", "pending");
      await fundCurrent();
    } else {
      message("wallet", funded ? "Freighter is connected to Stellar Testnet." : "Freighter connected. Fund it to continue.");
    }
  });
}

async function confirm(record: Pending, result: Submission) {
  if (record.action === "register") {
    if (result.value === null || result.value === undefined) throw new Error("Registration returned no subaccount ID.");
    const id = parseU64(String(result.value));
    customerId = id;
    if (wallet) setStored(`account:${wallet.address}`, id.toString());
  }
  savePending(null);
  activities = [{ hash: result.hash, action: record.action, amount: record.amount, ledger: result.ledger },
    ...activities.filter((entry) => entry.hash !== result.hash)].slice(0, 10);
  setStored("activity", activities);
  showActivity();
  ui.amount.value = "";
  message("funds", record.action === "register" ? `Subaccount #${customerId} opened.` : `${actionNames[record.action]} confirmed.`, "info", result.hash);
  try { await updateBalances(); }
  catch { message("funds", "Transaction confirmed. Use Refresh to update balances.", "info", result.hash); }
}

async function checkPending() {
  if (!pending) return;
  const record = pending;
  const result = await currentClient().rpc.getTransaction(record.hash);
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    await confirm(record, transactionResult(result, record.hash));
  } else if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
    savePending(null);
    message("funds", "Stellar rejected the transaction. Your subaccount was unchanged.", "error", record.hash);
  } else if (Date.now() > record.deadline) {
    savePending(null);
    message("funds", "The transaction expired without confirmation. Check activity before resubmitting.", "error", record.hash);
  } else {
    message("funds", "Waiting for confirmation. Check again in a few seconds.", "pending", record.hash);
  }
}

async function act() {
  if (!wallet) { showPanel("wallet"); return; }
  if (pending) { await run("funds", "Looking up your transaction…", checkPending); return; }
  if (!funded) { await run("wallet", "Funding your wallet…", fundCurrent); return; }
  const signer = wallet;
  await run("funds", "Simulating on Testnet…", async () => {
    const vault = currentClient();
    const action: Action = customerId === null || !subaccount?.active ? "register" : mode;
    const amount = action === "register" ? 0n : parseAssetUnits(ui.amount.value.trim());
    let transaction: Transaction;
    if (action === "register" || customerId === null) {
      transaction = await vault.register(signer.address);
    } else if (action === "deposit") {
      transaction = await vault.deposit(signer.address, customerId, amount);
    } else {
      if (subaccount && amount > subaccount.balance) throw new Error("The withdrawal exceeds your subaccount balance.");
      const recipient = authorizationAddress(ui.recipient.value.trim() || signer.address).toString();
      if (recipient === vault.vault) throw new Error("Choose a recipient outside this vault.");
      transaction = await vault.withdraw(signer.address, customerId, recipient, amount);
    }
    message("funds", signer.kind === "freighter" ? "Approve the transaction in Freighter…" : "Signing with your demo wallet…", "pending");
    const signed = await signer.sign(transaction);
    const hash = transactionHash(signed);
    const expiration = Number(signed.timeBounds?.maxTime ?? 0) * 1_000;
    const record: Pending = { hash, action, amount: amount.toString(), deadline: Math.max(Date.now(), expiration) + 30_000 };
    savePending(record);
    message("funds", "Waiting for Stellar ledger confirmation…", "pending", hash);
    try { await confirm(record, await submit(vault.rpc, signed)); }
    catch (error) {
      if (error instanceof RejectedTransaction) {
        savePending(null);
        message("funds", "Stellar rejected the transaction. Check your balance and try again.", "error", hash);
      } else if (pending) {
        message("funds", "Confirmation is pending. Check this transaction before retrying.", "pending", hash);
      } else throw error;
    }
  });
}

async function loadApp() {
  const response = await fetch(`${import.meta.env.BASE_URL}testnet.json`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Could not load the Testnet deployment configuration.");
  const data = await response.json() as Settings;
  if (!StrKey.isValidContract(data.vault) || !StrKey.isValidEd25519PublicKey(data.readAccount)
    || new URL(data.rpcUrl).protocol !== "https:") throw new Error("The Testnet deployment configuration is invalid.");
  const vault = new VaultClient(data.rpcUrl, Networks.TESTNET, data.vault);
  await vault.verifyNetwork(30);
  const config = await vault.config(data.readAccount);
  if (config.asset !== Asset.native().contractId(Networks.TESTNET) || config.schema_version !== 1) {
    throw new Error("The dashboard requires a MuxVault v1 deployment backed by native XLM.");
  }
  settings = data;
  client = vault;
  ui.vault.textContent = shorten(data.vault);
  ui.copyVault.title = data.vault;
  ui.copyVault.disabled = false;
  ui.explorer.href = `${explorer}/contract/${data.vault}`;
  ui.explorer.hidden = false;
  const stored = getStored("activity");
  activities = Array.isArray(stored) ? stored.filter(validActivity).slice(0, 10) : [];
  showActivity();
  await updateBalances();
}

function switchMode(next: Mode) {
  mode = next;
  if (!pending) message("funds");
  render();
}

ui.nav.addEventListener("click", () => showPanel("wallet"));
ui.start.addEventListener("click", () => showPanel(wallet ? "funds" : "wallet"));
ui.deposit.addEventListener("click", () => switchMode("deposit"));
ui.withdraw.addEventListener("click", () => switchMode("withdraw"));
for (const button of presets) button.addEventListener("click", () => {
  ui.amount.value = button.dataset.value ?? "";
  ui.amount.focus();
});
ui.max.addEventListener("click", () => {
  if (!subaccount) return;
  ui.amount.value = formatAssetUnits(subaccount.balance);
  ui.amount.focus();
});
ui.fundsForm.addEventListener("submit", (event) => { event.preventDefault(); void act(); });
ui.create.addEventListener("click", () => { void connected("demo"); });
ui.freighter.addEventListener("click", () => { void connected("freighter"); });
ui.fund.addEventListener("click", () => { void run("wallet", "Funding your wallet…", fundCurrent); });
ui.disconnect.addEventListener("click", () => {
  if (wallet?.kind === "demo" && (pending || (subaccount?.balance ?? 0n) > 0n)
    && !window.confirm("Disconnecting discards this demo key. Keep the wallet open if you want to withdraw its test XLM.")) return;
  wallet = null;
  funded = false;
  customerId = null;
  subaccount = null;
  pending = null;
  ui.recipient.value = "";
  message("wallet");
  message("funds");
  render();
});
ui.copyWallet.addEventListener("click", () => { if (wallet) void copy(wallet.address); });
ui.copyVault.addEventListener("click", () => { if (settings) void copy(settings.vault); });
ui.accountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void run("wallet", "Looking up the subaccount…", async () => {
    await loadId(parseU64(ui.accountId.value.trim()));
    ui.accountDetails.open = false;
    message("wallet", `Subaccount #${customerId} loaded.`);
  });
});
ui.refresh.addEventListener("click", () => {
  void run("funds", "Refreshing ledger state…", async () => {
    if (!client) await loadApp();
    if (wallet) funded = await isFunded(currentClient(), wallet.address);
    if (pending) await checkPending();
    else {
      await updateBalances();
      message("funds", "Balances refreshed.");
    }
  });
});

void run("wallet", "Connecting to Stellar Testnet…", async () => {
  await loadApp();
  message("wallet");
});
