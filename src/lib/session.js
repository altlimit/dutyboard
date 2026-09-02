// The signed-in person, as reactive state.
//
// `altengine.js` deliberately knows nothing about Vue — it is the plain description of
// how to talk to the services. This is the two-line bridge: it mirrors that module's
// session into refs, so a view that renders `signedIn` re-renders when it changes.

import { ref } from "vue";
import { currentUser, isSignedIn, onSessionChange } from "./altengine.js";

export const user = ref(currentUser());
export const signedIn = ref(isSignedIn());

onSessionChange(() => {
  user.value = currentUser();
  signedIn.value = isSignedIn();
});
