import type { FeedEndpoint, PriceSource, SourceReading } from "./feeds.js";

export class PriceFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceFeedError";
  }
}

export interface MockPriceSource extends PriceSource {
  /** Key is `chainlink:ETH/USD` or `pyth:USDC/USD`. A null reading removes the key. */
  set(key: string, reading: SourceReading | null): void;
  /** Later reads throw. checkPayment treats that as a missing price and denies. */
  kill(): void;
}

/**
 * Placeholder for a network price client. It always fails closed.
 * Pyth Hermes would need PYTH_API_KEY. This function does not read that variable.
 * Chainlink on-chain reads need no API key. This function does not dial a mainnet RPC.
 */
export function createLivePriceSource(): PriceSource {
  return {
    async read(): Promise<SourceReading | null> {
      throw new PriceFeedError(
        "Live prices are not implemented. A Pyth Hermes client would need PYTH_API_KEY. Chainlink on-chain reads need no API key, and this package does not dial a mainnet RPC.",
      );
    },
  };
}

export function createMockPriceSource(seed?: Record<string, SourceReading>): MockPriceSource {
  const readings = new Map<string, SourceReading>();
  if (seed) {
    for (const [key, reading] of Object.entries(seed)) {
      readings.set(key, { ...reading });
    }
  }
  let killed = false;
  return {
    async read(endpoint: FeedEndpoint): Promise<SourceReading | null> {
      if (killed) {
        throw new PriceFeedError("Price feed is unavailable.");
      }
      const found = readings.get(`${endpoint.source}:${endpoint.pair}`);
      return found ? { priceUsd: found.priceUsd, observedAt: found.observedAt } : null;
    },
    set(key: string, reading: SourceReading | null): void {
      if (reading === null) {
        readings.delete(key);
        return;
      }
      readings.set(key, { priceUsd: reading.priceUsd, observedAt: reading.observedAt });
    },
    kill(): void {
      killed = true;
    },
  };
}
