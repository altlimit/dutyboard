// A tiny reactive wrapper over the altengine client's session so views react to
// sign-in/out. The client owns token storage; this just mirrors the current user
// into Vue reactivity and exposes sign-in/out helpers that keep both in sync.

import { reactive, computed } from "vue";
import * as ae from "./altengine.js";

const state = reactive({
  user: ae.currentUser(),
});

function sync() {
  state.user = ae.currentUser();
}

export const session = {
  state,
  isSignedIn: computed(() => !!state.user),
  uid: computed(() => state.user && state.user.uid),
  displayName: computed(() => {
    const u = state.user;
    if (!u) return "";
    // The display name is a sign-up field, so it lives in `profile` (not `claims`,
    // which is admin-set/authoritative).
    const p = u.profile || {};
    return p.name || p.username || u.identifier || "there";
  }),

  async signIn(identifier, password) {
    const res = await ae.signIn(identifier, password);
    sync();
    return res; // { user } or { mfaRequired, mfaToken }
  },
  async verifyMfa(mfaToken, code) {
    await ae.verifyMfa(mfaToken, code);
    sync();
  },
  async signUp(fields) {
    await ae.signUp(fields);
    sync();
  },
  async passwordlessVerify(identifier, code) {
    const res = await ae.passwordlessVerify(identifier, code);
    sync();
    return res;
  },
  async signOut() {
    await ae.signOut();
    sync();
  },
};
