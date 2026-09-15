import { report } from "./harness";
import { run as runEnv } from "./env.test";
import {
  run as runRemote,
  runFlakeRefs,
  runNixCommands,
  runFlakeSettings,
  runNixExtensions,
  runServerLifecycle,
  runProductDetection,
  runDistributionLayout,
  runServerAcquisition,
  runServerRelease,
  runShellRestore,
} from "./remote.test";
import { run as runActivation } from "./activation.test";
import { run as runDirenv } from "./direnv.test";
import { run as runSource } from "./source.test";
import { run as runSettings } from "./settings.test";
import { run as runNix } from "./nix.e2e.test";
import { run as runServer, runIdleShutdown } from "./server.e2e.test";

async function main(): Promise<void> {
  await runEnv();
  await runRemote();
  await runFlakeRefs();
  await runNixCommands();
  await runShellRestore();
  await runServerLifecycle();
  await runServerRelease();
  await runProductDetection();
  await runDistributionLayout();
  await runServerAcquisition();
  await runNixExtensions();
  await runFlakeSettings();
  await runDirenv();
  await runActivation();
  await runSource();
  await runSettings();
  await runNix();
  await runServer();
  await runIdleShutdown();
  report();
}

void main();
