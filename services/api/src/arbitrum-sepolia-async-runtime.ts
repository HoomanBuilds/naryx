import type { EvmReadPort } from "@naryx/adapter-evm";
import {
  createArbitrumSepoliaAsyncContextProvider,
  type ArbitrumSepoliaAsyncContextProviderOptions,
} from "./arbitrum-sepolia-async-context-provider.js";
import {
  createEvmTestnetAsyncObservationPort,
  type EvmTestnetAsyncObservationPort,
} from "./evm-testnet-runtime-ports.js";

export interface ArbitrumSepoliaAsyncRuntimeFactoryOptions
  extends ArbitrumSepoliaAsyncContextProviderOptions {
  readonly readPort: EvmReadPort;
}

export function createArbitrumSepoliaAsyncRuntimeFactory(
  options: ArbitrumSepoliaAsyncRuntimeFactoryOptions,
): () => EvmTestnetAsyncObservationPort {
  return () => createEvmTestnetAsyncObservationPort({
    contextProvider: createArbitrumSepoliaAsyncContextProvider(options),
    readPort: options.readPort,
  });
}
