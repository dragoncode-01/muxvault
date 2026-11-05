import { Asset, StrKey } from "@stellar/stellar-sdk";

export function stellarAsset(value: string): Asset {
  if (value === "native") return Asset.native();
  const [code, issuer, extra] = value.split(":");
  if (extra !== undefined || !/^[A-Za-z0-9]{1,12}$/.test(code) || !issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error("Expected native or CODE:ISSUER");
  }
  return new Asset(code, issuer);
}

export function assetInfo(value: string, passphrase: string) {
  const asset = stellarAsset(value);
  return {
    address: asset.contractId(passphrase),
    xdrHex: asset.toXDRObject().toXDR("hex"),
  };
}
