import { useConnectAuth } from "../../cloud/connectAuth";

export function useClerkLoadFailed() {
  return useConnectAuth().loadFailed === true;
}

export function retryClerkLoad() {
  // Clerk caches its failed script load for the life of the page and never
  // retries, so a reload is the only recovery.
  window.location.reload();
}
