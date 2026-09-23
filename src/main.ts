import { Game } from './core/Game';
import { capabilityError, probeCapabilities } from './core/Capabilities';

const $err = document.getElementById('err')!;
function fail(msg: unknown): void {
  $err.hidden = false;
  $err.textContent += (msg instanceof Error ? msg.stack ?? msg.message : String(msg)) + '\n';
}
addEventListener('error', (e) => fail(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));

async function boot(): Promise<void> {
  const caps = probeCapabilities();
  const problem = capabilityError(caps);
  if (problem) { fail(problem); return; }

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const bar = document.querySelector<HTMLElement>('#loading .bar i')!;
  const game = new Game(canvas);
  (window as unknown as { __game: Game }).__game = game;
  await game.init((f) => (bar.style.width = `${Math.round(f * 100)}%`));
  document.getElementById('loading')!.classList.add('done');
  game.start();
}

boot().catch(fail);
