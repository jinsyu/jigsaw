// The server's clock. Test hooks (local only) can move it forward to try the 10-second,
// one-minute and 24-hour rules without waiting.
export function createClock(base = Date.now) {
  let offset = 0;
  const now = () => base() + offset;
  now.advance = (ms) => {
    offset += ms;
  };
  return now;
}
