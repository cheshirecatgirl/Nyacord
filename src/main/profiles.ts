import { randomUUID } from "node:crypto";

import { CHANNELS, type ChannelId } from "../common/channels";
import { defaultProxy, normalizeProxy, type ProxyConfig } from "../common/network";
import type { PrivacyPolicy } from "../common/policy";
import { newProfileId, partitionFor, type Profile } from "../common/profile";
import type { SableConfig } from "./config";
import type { JsonStore } from "./store";

/**
 * Owns the profile list and the rule that there is always at least one
 * profile. A client that can end up with zero profiles has a state where it
 * shows nothing and offers no way out; that state simply does not exist here.
 */
export class ProfileStore {
  constructor(private readonly store: JsonStore<SableConfig>) {
    if (this.all().length === 0) {
      this.create({ name: "Discord", channel: "stable", ephemeral: false });
    }
  }

  all(): readonly Profile[] {
    return this.store.get().profiles;
  }

  find(id: string): Profile | undefined {
    return this.all().find((profile) => profile.id === id);
  }

  activeId(): string | null {
    return this.store.get().activeProfileId;
  }

  active(): Profile | undefined {
    const id = this.activeId();
    return id ? this.find(id) : undefined;
  }

  create(input: { name: string; channel: ChannelId; ephemeral: boolean }): Profile {
    const id = newProfileId(randomUUID);
    const unique = this.all().some((p) => p.id === id) ? `${id}${this.all().length}` : id;
    const now = Date.now();
    const profile: Profile = {
      id: unique,
      name: input.name.trim().slice(0, 48) || CHANNELS[input.channel].label,
      channel: input.channel,
      ephemeral: input.ephemeral,
      proxy: defaultProxy(),
      createdAt: now,
      lastUsedAt: now,
    };
    this.store.update((draft) => {
      draft.profiles.push(profile);
      draft.activeProfileId ??= profile.id;
    });
    return profile;
  }

  rename(id: string, name: string): void {
    this.store.update((draft) => {
      const profile = draft.profiles.find((p) => p.id === id);
      if (profile) profile.name = name.trim().slice(0, 48) || profile.name;
    });
  }

  remove(id: string): void {
    this.store.update((draft) => {
      draft.profiles = draft.profiles.filter((p) => p.id !== id);
      if (draft.activeProfileId === id) draft.activeProfileId = draft.profiles[0]?.id ?? null;
    });
    if (this.all().length === 0) {
      this.create({ name: "Discord", channel: "stable", ephemeral: false });
    }
  }

  setActive(id: string): void {
    if (!this.find(id)) return;
    this.store.update((draft) => {
      draft.activeProfileId = id;
      const profile = draft.profiles.find((p) => p.id === id);
      if (profile) profile.lastUsedAt = Date.now();
    });
  }

  /**
   * A profile may pin its own policy — "this account is paranoid, that one is
   * not" — otherwise it inherits the global one.
   */
  policyFor(id: string): PrivacyPolicy {
    return this.find(id)?.policy ?? this.store.get().policy;
  }

  proxyFor(id: string): ProxyConfig {
    return normalizeProxy(this.find(id)?.proxy);
  }

  /** Returns the normalized config that was actually stored, which may differ
   * from what was requested if the input failed validation. */
  setProxy(id: string, input: unknown): ProxyConfig {
    const proxy = normalizeProxy(input);
    this.store.update((draft) => {
      const profile = draft.profiles.find((p) => p.id === id);
      if (profile) profile.proxy = proxy;
    });
    return proxy;
  }

  partition(id: string): string {
    const profile = this.find(id);
    if (!profile) throw new Error(`unknown profile ${id}`);
    return partitionFor(profile);
  }
}
