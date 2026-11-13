import './ui/style.css';
import { Game } from './core/Game';

const canvas = document.getElementById('game') as HTMLCanvasElement;

async function main() {
  try {
    const game = new Game(canvas);
    (window as any).__game = game;
    await game.boot();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('bootmsg');
    if (el) el.textContent = 'Could not start: this game needs WebGL2 and WebAssembly. ' + (err as Error).message;
  }
}
void main();
