export function positionKey(symbol, isSimulated) {
  return `${symbol}:${isSimulated ? 'sim' : 'live'}`;
}

