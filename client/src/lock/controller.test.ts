import {LockController} from './controller';
import {AutoLock} from './autolock';
import {PinVault} from './pin';
import {PinAttemptLimiter, FREE_ATTEMPTS} from './attemptLimiter';
import {InMemorySecureStorage} from '../keys/keystore';

const identityHash = async (d: Uint8Array) => d;

async function setup() {
  const pins = new PinVault(new InMemorySecureStorage(), identityHash);
  await pins.setPins('1234', '9999');
  const autolock = new AutoLock(60_000);
  const onDuress = jest.fn(async () => undefined);
  const controller = new LockController(pins, autolock, onDuress);
  return {controller, autolock, onDuress};
}

describe('LockController', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('unlocks on the standard PIN without wiping', async () => {
    const {controller, autolock, onDuress} = await setup();
    expect(await controller.submitPin('1234')).toBe('unlocked');
    expect(autolock.getState()).toBe('unlocked');
    expect(onDuress).not.toHaveBeenCalled();
  });

  it('wipes then unlocks on the duress PIN', async () => {
    const {controller, autolock, onDuress} = await setup();
    expect(await controller.submitPin('9999')).toBe('wiped');
    expect(onDuress).toHaveBeenCalledTimes(1);
    // Indistinguishable from a normal unlock: the app opens either way.
    expect(autolock.getState()).toBe('unlocked');
  });

  it('rejects an invalid PIN and stays locked', async () => {
    const {controller, autolock, onDuress} = await setup();
    expect(await controller.submitPin('0000')).toBe('rejected');
    expect(autolock.getState()).toBe('locked');
    expect(onDuress).not.toHaveBeenCalled();
  });

  it('still wipes on the duress PIN while brute-force locked out (M2)', async () => {
    let now = 0;
    const storage = new InMemorySecureStorage();
    const limiter = new PinAttemptLimiter(storage, () => now);
    const pins = new PinVault(storage, identityHash, limiter);
    await pins.setPins('1234', '9999');
    const autolock = new AutoLock(60_000);
    const onDuress = jest.fn(async () => undefined);
    const controller = new LockController(pins, autolock, onDuress);

    // Routine wrong guesses on a seized device trip the escalating lockout.
    for (let i = 0; i <= FREE_ATTEMPTS; i++) {
      expect(await controller.submitPin('0000')).toBe('rejected');
    }
    // The standard PIN is now rejected outright (locked out) — and the wipe has NOT run.
    expect(await controller.submitPin('1234')).toBe('rejected');
    expect(onDuress).not.toHaveBeenCalled();

    // The duress PIN must STILL run the wipe and open the (now blank) app, indistinguishably.
    expect(await controller.submitPin('9999')).toBe('wiped');
    expect(onDuress).toHaveBeenCalledTimes(1);
    expect(autolock.getState()).toBe('unlocked');
  });
});
