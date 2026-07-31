import { app } from "electron";

import type { PrivacyPolicy, WebRtcPolicy } from "../common/policy";

/**
 * Command-line switches have to be set before Chromium starts, which means
 * before `app.whenReady()` and before we know which profile the user will pick.
 * They are therefore driven by the *global* policy only; per-profile overrides
 * apply to everything else (request filtering, permissions, headers) but not to
 * these process-wide flags. That asymmetry is called out in docs/PRIVACY.md.
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

export function applyChromiumSwitches(policy: PrivacyPolicy): void {
  // Renderers must never have Node. `enableSandbox` makes this the default for
  // every window, not something each BrowserWindow has to remember.
  app.enableSandbox();

  const disabledFeatures = [
    // Chromium's ad-privacy stack. We are not an ad platform; these only ever
    // create profiling surface.
    "PrivacySandboxSettings4",
    "InterestFeedContentSuggestions",
    "Translate",
    // Media Router probes the LAN for cast devices on startup.
    "MediaRouter",
    // Sends page-load timing to Google for "optimization hints".
    "OptimizationHints",
  ];

  app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));

  // Chromium reports network-error statistics back to Google by default.
  app.commandLine.appendSwitch("disable-domain-reliability");
  // No background component/extension updates.
  app.commandLine.appendSwitch("disable-component-update");
  // `<a ping>` and hyperlink auditing.
  app.commandLine.appendSwitch("no-pings");
  // Never let a crash handler upload anything.
  app.commandLine.appendSwitch("disable-breakpad");
  app.commandLine.appendSwitch("disable-crash-reporter");

  const rtc = webRtcSwitch(policy.webrtc);
  if (rtc) app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", rtc);

  // Keep mDNS-obfuscated ICE candidates on: they hide the LAN address from the
  // peer while still allowing local connectivity. Explicit so that a future
  // Chromium default flip does not silently change our posture.
  app.commandLine.appendSwitch("enable-features", "WebRtcHideLocalIpsWithMdns");
}
