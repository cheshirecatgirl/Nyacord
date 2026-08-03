import { app } from "electron";

import type { PrivacyPolicy, WebRtcPolicy } from "../common/policy";

/**
 * Chromium switches have to be set before `app.whenReady()`, and therefore
 * before we know which profile the user will pick. They follow the *global*
 * policy only; per-profile overrides cover request filtering, permissions and
 * headers, but never these. The asymmetry is called out in docs/PRIVACY.md.
 */

function webRtcSwitch(policy: WebRtcPolicy): string | null {
  switch (policy) {
    case "public_interface_only":
      return "default_public_interface_only";
    case "disable_non_proxied_udp":
      return "disable_non_proxied_udp";
    case "default":
      return null;
  }
}

/** Chromium features we turn off, with the reason each one is here. */
const DISABLED_FEATURES = [
  "PrivacySandboxSettings4", // ad-privacy stack; only ever profiling surface
  "InterestFeedContentSuggestions",
  "Translate",
  "MediaRouter", // probes the LAN for cast devices at startup
  "OptimizationHints", // sends page-load timing to Google
  "AutofillServerCommunication", // asks a Google endpoint to classify form fields
  "NetworkTimeServiceQuerying", // queries a Google time server
  "SegmentationPlatform", // on-device behavioural modelling
  /*
   * Conditional mediation is the passkey prompt that fires by itself when a
   * login page loads. Discord's "log in with a passkey" link uses a different
   * mediation mode and still works with these off.
   */
  "WebAuthenticationConditionalUI",
  "WebAuthenticationPasskeyUpgrade",
  "WebAuthenticationImmediateGet",
];

export function applyChromiumSwitches(policy: PrivacyPolicy): void {
  // Makes the sandbox the process-wide default instead of something every
  // window has to remember.
  app.enableSandbox();

  /*
   * Site isolation is already Chromium's default. Naming it means a future
   * default flip cannot cost us Spectre and cross-origin memory protection
   * without the diff saying so.
   */
  app.commandLine.appendSwitch("site-per-process");

  // An unrecognized name here is ignored, so the list degrades to a no-op
  // across Chromium versions. A typo is silent.
  app.commandLine.appendSwitch("disable-features", DISABLED_FEATURES.join(","));

  // Variations, component and extension updates, and the rest of the periodic
  // fetches that happen with no page open.
  app.commandLine.appendSwitch("disable-background-networking");
  // Field trials change behaviour between runs. A privacy posture should not
  // vary by lottery.
  app.commandLine.appendSwitch("disable-field-trial-config");
  app.commandLine.appendSwitch("disable-domain-reliability");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("no-pings"); // `<a ping>` and hyperlink auditing
  app.commandLine.appendSwitch("disable-breakpad");
  app.commandLine.appendSwitch("disable-crash-reporter");

  const rtc = webRtcSwitch(policy.webrtc);
  if (rtc) app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", rtc);

  // mDNS-obfuscated ICE candidates hide the LAN address from the peer while
  // keeping local connectivity. Set explicitly so a default flip is visible.
  app.commandLine.appendSwitch("enable-features", "WebRtcHideLocalIpsWithMdns");
}
