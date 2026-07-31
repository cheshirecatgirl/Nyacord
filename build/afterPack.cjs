// Flips Electron fuses on the packaged binary.
//
// Fuses are compile-time-ish switches burned into the Electron executable.
// They matter because several of Electron's most useful attack primitives are
// enabled by default: `ELECTRON_RUN_AS_NODE` turns the shipped binary into a
// general-purpose Node interpreter, and `NODE_OPTIONS` lets an attacker who
// controls the environment inject a module into our process.
//
// Turning them off is the difference between "an attacker needs a bug in Nyacord"
// and "an attacker needs an environment variable".
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  const name = packager.appInfo.productFilename;

  const executable = {
    darwin: path.join(appOutDir, `${name}.app`),
    win32: path.join(appOutDir, `${name}.exe`),
    linux: path.join(appOutDir, name.toLowerCase()),
  }[electronPlatformName];

  if (!executable) {
    console.warn(`[nyacord] no fuse target for platform ${electronPlatformName}`);
    return;
  }

  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === "darwin",

    // Do not let the binary be used as a Node interpreter.
    [FuseV1Options.RunAsNode]: false,
    // Encrypt the cookie store at rest using the OS keychain where available.
    [FuseV1Options.EnableCookieEncryption]: true,
    // Ignore NODE_OPTIONS and --inspect: no environment-driven code injection.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Refuse to run if the asar has been tampered with, and refuse to load app
    // code from anywhere but the asar. Together these stop the classic
    // "drop a modified JS file next to the app" persistence trick.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // file:// pages get no extra privileges.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });

  console.log(`[nyacord] fuses applied to ${executable}`);
};
