import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ClerkConnectAuthProvider } from "./ClerkConnectAuthProvider";
import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

/**
 * Browser half of the managed-auth boundary, loaded lazily from the entry so
 * cloudless local mode never downloads a Clerk runtime. The browser provider
 * stays small on its own: it hotloads clerk-js at runtime instead of bundling
 * it.
 */
export default function BrowserManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <AppAtomRegistryProvider>
      <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
        <ClerkConnectAuthProvider>
          <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
        </ClerkConnectAuthProvider>
      </ClerkProvider>
    </AppAtomRegistryProvider>
  );
}
