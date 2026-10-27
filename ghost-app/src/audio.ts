type Sound =
  | "click"
  | "spawn"
  | "barrel"
  | "scare"
  | "manifest"
  | "whisper"
  | "error"
  | "connect"
  | "disconnect"
  | "hit";

/**
 * Tiny synthesized sound layer. No external assets, so the client stays a
 * single static bundle and works over a phone hotspot.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = true;

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  resume(): void {
    this.ensure();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master) this.master.gain.value = enabled ? 0.35 : 0;
  }

  play(sound: Sound): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;

    switch (sound) {
      case "click":
        this.tone(520, 0.05, "triangle", 0.18, now);
        break;
      case "spawn":
        this.tone(90, 0.35, "sawtooth", 0.3, now, 40);
        this.noise(0.25, 0.18, now, 900);
        break;
      case "barrel":
        this.noise(0.55, 0.55, now, 300);
        this.tone(55, 0.5, "sine", 0.45, now, 28);
        break;
      case "scare":
        this.noise(0.4, 0.16, now, 2200);
        this.tone(1200, 0.25, "sine", 0.08, now, 300);
        break;
      case "manifest":
        this.tone(220, 1.4, "sine", 0.2, now, 110);
        this.tone(330, 1.2, "triangle", 0.1, now, 165);
        break;
      case "whisper":
        this.noise(0.9, 0.12, now, 1500);
        break;
      case "error":
        this.tone(180, 0.18, "square", 0.16, now, 90);
        break;
      case "connect":
        this.tone(440, 0.12, "sine", 0.14, now);
        this.tone(660, 0.18, "sine", 0.12, now + 0.1);
        break;
      case "disconnect":
        this.tone(330, 0.2, "sine", 0.12, now, 180);
        break;
      case "hit":
        this.tone(70, 0.3, "square", 0.2, now, 40);
        break;
    }
  }

  private tone(
    freq: number,
    duration: number,
    type: OscillatorType,
    gain: number,
    at: number,
    endFreq?: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), at + duration);
    }
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(env).connect(this.master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  private noise(duration: number, gain: number, at: number, lowpass: number): void {
    if (!this.ctx || !this.master) return;
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(filter).connect(env).connect(this.master);
    src.start(at);
  }
}
