(() => {
  const BAND_COUNT = 96;
  const NOTES = ["♪", "♫", "✦"];

  class LazySongVisualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext("2d");
      this.frame = { playing: false, hasSignal: false, bands: [] };
      this.levels = Array.from({ length: BAND_COUNT }, () => Math.random() * 0.08 + 0.035);
      this.fallbackLevels = Array.from({ length: BAND_COUNT }, () => Math.random() * 0.18);
      this.particles = [];
      this.pulse = 0;
      this.previousTime = 0;
      this.nextFallbackBeat = performance.now() + 120;
      this.fallbackBeatMs = 420 + Math.random() * 260;
      this.destroyed = false;
      this.tick = this.tick.bind(this);
      this.animationId = requestAnimationFrame(this.tick);
    }

    setFrame(frame) {
      this.frame = frame && typeof frame === "object"
        ? frame
        : { playing: false, hasSignal: false, bands: [] };
    }

    tick(now) {
      if (this.destroyed) return;
      const elapsed = Math.min(0.06, Math.max(0.001, (now - (this.previousTime || now)) / 1000));
      this.previousTime = now;
      this.resizeCanvas();
      this.updateLevels(now, elapsed);
      this.draw(now, elapsed);
      this.animationId = requestAnimationFrame(this.tick);
    }

    resizeCanvas() {
      const rect = this.canvas.getBoundingClientRect();
      const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    updateLevels(now, elapsed) {
      const audioLevels = Array.isArray(this.frame.bands) ? this.frame.bands : [];
      const hasAudio = Boolean(this.frame.playing && this.frame.hasSignal && audioLevels.length);
      const hasPlayback = Boolean(this.frame.playing);

      if (this.frame.beat) this.triggerBeat(now);
      if (hasPlayback && !hasAudio && now >= this.nextFallbackBeat) {
        this.triggerBeat(now);
        this.fallbackLevels = Array.from({ length: BAND_COUNT }, (_, index) => {
          const lowBoost = index < 20 ? 0.7 : 0;
          return Math.random() * 0.72 + lowBoost;
        });
        this.fallbackBeatMs = 400 + Math.random() * 280;
        this.nextFallbackBeat = now + this.fallbackBeatMs;
      }

      this.pulse = Math.max(0, this.pulse - elapsed * (hasAudio ? 3.6 : 2.9));
      for (let index = 0; index < BAND_COUNT; index += 1) {
        let target;
        if (hasAudio) {
          target = Math.max(0.035, Math.min(1, Number(audioLevels[index]) || 0));
        } else if (hasPlayback) {
          const beatShape = this.pulse * (index < 20 ? 0.56 : 0.36);
          target = 0.07 + this.fallbackLevels[index] * beatShape;
        } else {
          const wave = (Math.sin(now / 680 + index * 0.7) + 1) * 0.5;
          target = 0.045 + wave * 0.1 + this.fallbackLevels[index] * 0.035;
        }
        const smoothing = hasAudio ? 0.3 : 0.16;
        this.levels[index] += (target - this.levels[index]) * smoothing;
      }

      this.particles = this.particles.filter((particle) => particle.life > 0);
      this.particles.forEach((particle) => {
        particle.x += particle.vx * elapsed;
        particle.y += particle.vy * elapsed;
        particle.life -= elapsed * 0.9;
      });
    }

    triggerBeat(now) {
      if (now - (this.lastBeat || 0) < 160) return;
      this.lastBeat = now;
      this.pulse = 1;
      for (let index = 0; index < 2; index += 1) {
        this.particles.push({
          x: Math.random() * (this.canvas.clientWidth || 140),
          y: (this.canvas.clientHeight || 42) * (0.52 + Math.random() * 0.3),
          vx: (Math.random() - 0.5) * 14,
          vy: -8 - Math.random() * 18,
          size: 8 + Math.random() * 5,
          life: 0.8 + Math.random() * 0.3,
          note: NOTES[Math.floor(Math.random() * NOTES.length)]
        });
      }
    }

    draw(now) {
      const context = this.context;
      const width = this.canvas.clientWidth || 140;
      const height = this.canvas.clientHeight || 42;
      context.clearRect(0, 0, width, height);

      if (this.pulse > 0.02) {
        const glow = context.createRadialGradient(width / 2, height / 2, 2, width / 2, height / 2, width * 0.55);
        glow.addColorStop(0, `rgba(138, 92, 246, ${this.pulse * 0.15})`);
        glow.addColorStop(1, "rgba(138, 92, 246, 0)");
        context.fillStyle = glow;
        context.fillRect(0, 0, width, height);
      }

      const bandCount = Math.min(BAND_COUNT, Math.max(12, Math.floor(width / 8)));
      const gap = Math.min(2.5, width / (bandCount * 3));
      const barWidth = (width - gap * (bandCount - 1)) / bandCount;
      const floor = height - 2;
      const maxBarHeight = Math.max(3, height - 6);
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#7654e8");
      gradient.addColorStop(0.42, "#bd62f2");
      gradient.addColorStop(0.72, "#7288ff");
      gradient.addColorStop(1, "#45d8e8");
      context.fillStyle = gradient;

      for (let index = 0; index < bandCount; index += 1) {
        const sourceStart = Math.floor(index * BAND_COUNT / bandCount);
        const sourceEnd = Math.max(sourceStart + 1, Math.floor((index + 1) * BAND_COUNT / bandCount));
        let level = 0;
        for (let sourceIndex = sourceStart; sourceIndex < sourceEnd; sourceIndex += 1) {
          level += this.levels[sourceIndex];
        }
        level /= sourceEnd - sourceStart;
        const randomFlicker = 0.94 + Math.sin(now / 110 + index * 1.9) * 0.06;
        const barHeight = Math.max(3, level * maxBarHeight * randomFlicker + this.pulse * (index < bandCount * 0.2 ? 4 : 1.5));
        const x = index * (barWidth + gap);
        const y = floor - Math.min(maxBarHeight, barHeight);
        const radius = Math.min(barWidth / 2, barHeight / 2);
        context.beginPath();
        if (typeof context.roundRect === "function") context.roundRect(x, y, barWidth, barHeight, radius);
        else context.rect(x, y, barWidth, barHeight);
        context.fill();
      }

      context.textAlign = "center";
      context.textBaseline = "middle";
      if (height > 24) this.particles.forEach((particle) => {
        context.globalAlpha = Math.max(0, Math.min(1, particle.life));
        context.fillStyle = "#d9c4ff";
        context.font = `600 ${particle.size}px system-ui, sans-serif`;
        context.fillText(particle.note, particle.x, particle.y);
      });
      context.globalAlpha = 1;
    }

    destroy() {
      this.destroyed = true;
      cancelAnimationFrame(this.animationId);
      this.particles = [];
    }
  }

  window.LazySongVisualizer = LazySongVisualizer;
})();
