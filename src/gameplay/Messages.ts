/*
 * Short messages across the screen — the crew's calls, what a key just did — each shown for a few seconds.
 */
export class Messages {
  private readonly el = document.getElementById('toast')!;
  private text = '';
  private t = 0;

  say(text: string, seconds: number): void {
    this.text = text;
    this.t = seconds;
    this.el.textContent = text;
    this.el.classList.add('on');
  }

  update(dt: number): void {
    if (this.t <= 0) return;
    this.t -= dt;
    if (this.t <= 0) { this.text = ''; this.el.classList.remove('on'); }
  }

  get current(): string {
    return this.text;
  }
}
