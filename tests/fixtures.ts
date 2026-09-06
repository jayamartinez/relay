import {
  accountHandle,
  accountNumber,
  encryptEnvelope,
  identity,
  makeControl,
  makeRecovery,
  randomKey,
  wrapRoot,
} from "@relay/crypto";
import { emptyWorkspace } from "@relay/protocol";
export async function fixture() {
  const account = accountNumber();
  const handle = await accountHandle(account);
  const device = await identity();
  const root = randomKey();
  const secret = randomKey();
  const recovery = await makeRecovery(secret, handle);
  const control = await makeControl(
    {
      version: 1,
      account: handle,
      generation: 0,
      previous: "genesis",
      epoch: 1,
      actor: device.device.id,
      members: [device.device],
      recovery,
      boxes: {
        [device.device.id]: await wrapRoot(
          root,
          device.device.exchange,
          handle,
          1,
          device.device.id,
        ),
        recovery: await wrapRoot(root, recovery.exchange, handle, 1, "recovery"),
      },
    },
    device.signing,
  );
  const workspace = emptyWorkspace();
  const snapshot = await encryptEnvelope(
    root,
    device.signing,
    {
      version: 1,
      account: handle,
      epoch: 1,
      sender: device.device.id,
      sequence: 0,
      base: 0,
      type: "snapshot",
    },
    workspace,
  );
  return { account, handle, device, root, secret, control, workspace, snapshot };
}
