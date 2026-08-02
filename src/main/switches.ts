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

  /**
   * Site isolation, stated rather than assumed.
   *
   * It is Chromium's answer to Spectre and to a compromised renderer reading
   * another origin's memory, and it is on by default — but "on by default" is
   * a fact about the version we happen to ship, not a guarantee. Naming it
   * means a future default flip, or an embedder that turns it off, cannot
   * quietly cost us the property.
   */
  app.commandLine.appendSwitch("site-per-process");

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
    // Conditional mediation is the passkey prompt that fires on its own when a
    // login page loads, before you have asked for anything. Discord's login
    // screen also has a normal "log in with a passkey" link, which uses a
    // different mediation mode and keeps working with these off.
    "WebAuthenticationConditionalUI",
    "WebAuthenticationPasskeyUpgrade",
    "WebAuthenticationImmediateGet",
    // Autofill talks to a Google endpoint to classify form fields. We have one
    // login form and it is Discord's; nothing here needs a server's opinion.
    "AutofillServerCommunication",
    // Queries a Google time server to detect a skewed clock.
    "NetworkTimeServiceQuerying",
    // On-device behavioural modelling, for features a chat client does not have.
    "SegmentationPlatform",
  ];

  /**
   * An unrecognized feature name is ignored rather than rejected, so this list
   * degrades to a no-op across Chromium versions instead of failing to start.
   * Convenient, and worth knowing: a typo here is silent.
   */
  app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));

  /**
   * The umbrella over Chromium's background traffic: variations, component and
   * extension updates, and the rest of the periodic fetches that happen with no
   * page open. Several of the individual switches below are inside it; they are
   * kept because they are the ones worth being explicit about.
   */
  app.commandLine.appendSwitch("disable-background-networking");
  // Field-trial configuration is fetched and changes behaviour between runs.
  // A client whose privacy posture is the product should not vary by lottery.
  app.commandLine.appendSwitch("disable-field-trial-config");

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
