// Owns the signing key for rebuilt APKs. The key lives in the data volume, so
// every rebuilt version of an app carries the same signature and updates install
// over each other.

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./exec";
import { config } from "./config";

const keystore = join(config.keyDir, "signer.p12");
const passFile = join(config.keyDir, "signer.pass");
const ALIAS = "apk-yiin-lt";

export let signerFingerprint = "";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function init(): Promise<void> {
  await mkdir(config.keyDir, { recursive: true });
  if (!(await exists(keystore))) {
    const pass = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    await Bun.write(passFile, pass);
    await run([
      "keytool", "-genkeypair", "-keystore", keystore, "-storetype", "PKCS12",
      "-storepass:file", passFile, "-keypass:file", passFile, "-alias", ALIAS,
      "-keyalg", "RSA", "-keysize", "3072", "-validity", "36500",
      "-dname", "CN=apk.yiin.lt rebuilt APK",
    ]);
  }
  const out = await run(["keytool", "-list", "-v", "-keystore", keystore, "-storepass:file", passFile, "-alias", ALIAS]);
  signerFingerprint = out.match(/SHA256:\s*([0-9A-F:]+)/)?.[1] ?? "";
}

export const signerReady = init();

export async function signApk(input: string, output: string): Promise<void> {
  await run([
    "apksigner", "sign", "--ks", keystore, "--ks-type", "PKCS12", "--ks-key-alias", ALIAS,
    "--ks-pass", `file:${passFile}`, "--out", output, input,
  ]);
  await run(["apksigner", "verify", output]);
}
