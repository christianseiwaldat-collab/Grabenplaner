(function (root, factory) {
  "use strict";
  const materials = factory();
  if (typeof module === "object" && module.exports) module.exports = materials;
  else root.GrabenplanerBranchMaterials = materials;
}(globalThis, function () {
  "use strict";

  const size = 512;
  const surfaces = {
    road: { tileMetres: 2.6, rgb: [62, 65, 68], aggregate: 1, seed: 11 },
    parking: { tileMetres: 3, rgb: [88, 92, 93], aggregate: .9, seed: 23 },
    concrete: { tileMetres: 2, rgb: [158, 155, 145], aggregate: .55, seed: 31 },
    pavers: { tileMetres: 2.4, rgb: [175, 171, 159], aggregate: .59, joints: 6, seed: 37 },
    grass: { tileMetres: 2.7, rgb: [111, 118, 79], aggregate: .9, grass: true, seed: 53 },
    paint: { tileMetres: 1.8, rgb: [223, 222, 207], aggregate: .48, seed: 79 },
    facade: { tileMetres: 2.4, rgb: [184, 184, 176], aggregate: .27, panels: 2, seed: 83 },
    ceramic: { tileMetres: 2.1, rgb: [217, 215, 201], aggregate: .24, joints: 3, seed: 89 },
    wood: { tileMetres: 2.4, rgb: [154, 119, 88], aggregate: .36, wood: true, seed: 97 },
  };

  function hash(x, y, seed) {
    let value = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b) ^ Math.imul(seed, 0xc2b2ae35);
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    return ((value ^ (value >>> 15)) >>> 0) / 0x100000000;
  }

  function noise(u, v, columns, rows, seed) {
    const x = u * columns, y = v * rows;
    const i = Math.floor(x), j = Math.floor(y);
    const a = x - i, b = y - j;
    const tx = a * a * (3 - 2 * a), ty = b * b * (3 - 2 * b);
    const nextX = (i + 1) % columns, nextY = (j + 1) % rows;
    const top = hash(i, j, seed) * (1 - tx) + hash(nextX, j, seed) * tx;
    const bottom = hash(i, nextY, seed) * (1 - tx) + hash(nextX, nextY, seed) * tx;
    return top * (1 - ty) + bottom * ty;
  }

  function pixels(name) {
    const material = surfaces[name];
    const { rgb, seed, aggregate } = material;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      const v = y / size;
      for (let x = 0; x < size; x += 1) {
        const u = x / size;
        const grit = hash(x, y, seed);
        let value = (noise(u, v, 5, 5, seed) - .5) * 15;
        value += (noise(u, v, 83, 83, seed + 1) - .5) * 29 * aggregate;
        value += (grit - .5) * 32 * aggregate;
        if (grit > .97) value += 22 * aggregate;

        if (material.joints) {
          const count = material.joints;
          const row = Math.floor(v * count);
          const shifted = (u + (name === "pavers" && row % 2 ? .5 / count : 0)) % 1;
          const column = Math.floor(shifted * count);
          const across = shifted * count - column;
          const down = v * count - row;
          const edge = Math.min(across, 1 - across, down, 1 - down);
          const joint = name === "pavers" ? .012 : .008;
          value += (hash(column, row, seed + 8) - .5) * 14;
          if (edge < joint) value -= 48;
          else if (edge < joint * 2) value += 11;
        }
        if (material.grass) value += (noise(u, v, 12, 17, seed + 2) - .5) * 27;
        if (material.panels) {
          const column = u * material.panels;
          value += (hash(Math.floor(column), 0, seed + 8) - .5) * 8;
          if (column % 1 < .007) value -= 39;
          else if (column % 1 < .014) value += 13;
        }
        if (material.wood) {
          const plank = v * 12;
          value += (noise(u, v, 8, 204, seed + 2) - .5) * 38;
          value += (hash(0, Math.floor(plank), seed + 3) - .5) * 13;
          if (plank % 1 < .013) value -= 31;
        }
        if (name === "paint" && grit < .045) value -= 38;

        const offset = (y * size + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          data[offset + channel] = Math.max(0, Math.min(255, Math.round(rgb[channel] + value)));
        }
        data[offset + 3] = 255;
      }
    }
    return data;
  }

  // Original sample artwork on the paper, painted into its own texture.
  function fineArt(ctx, monochrome) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const margin = Math.round(w * .055);
    ctx.fillStyle = "#f5f2e9";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(margin, margin, w - 2 * margin, h - 2 * margin);
    ctx.clip();
    ctx.scale(w / 512, h / 512);
    const sky = ctx.createLinearGradient(0, 0, 0, 340);
    sky.addColorStop(0, monochrome ? "#4f6167" : "#3c6b86");
    sky.addColorStop(1, monochrome ? "#dde1dd" : "#e9b88f");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 512, 512);
    const shape = (points, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(...points[0]);
      for (const point of points.slice(1)) ctx.lineTo(...point);
      ctx.closePath();
      ctx.fill();
    };
    shape([[0, 292], [54, 247], [101, 267], [146, 196], [190, 224], [261, 132],
      [298, 166], [351, 264], [414, 199], [512, 286], [512, 512], [0, 512]], monochrome ? "#606f74" : "#516777");
    shape([[190, 224], [261, 132], [298, 166], [335, 230], [294, 203], [272, 194],
      [245, 219], [249, 184], [217, 214]], monochrome ? "#dfe6e2" : "#f4e6d3");
    shape([[0, 340], [75, 310], [148, 339], [218, 300], [291, 345], [389, 303],
      [512, 333], [512, 512], [0, 512]], monochrome ? "#354748" : "#3a5351");
    const lake = ctx.createLinearGradient(0, 355, 0, 512);
    lake.addColorStop(0, monochrome ? "#899c9d" : "#81a5a8");
    lake.addColorStop(1, monochrome ? "#283f4c" : "#2d5e71");
    shape([[54, 417], [165, 370], [321, 351], [437, 365], [494, 409], [512, 512], [0, 512]], lake);
    ctx.fillStyle = "rgba(248,237,216,.24)";
    for (let i = 0; i < 36; i += 1) {
      const y = 370 + i * 3.1;
      const x = 115 + hash(i, 0, 53) * 268;
      ctx.fillRect(x, y, 6 + hash(i, 1, 53) * 70, 1);
    }
    shape([[0, 382], [82, 413], [119, 454], [181, 512], [0, 512]], monochrome ? "#283330" : "#263c34");
    ctx.restore();
  }

  return Object.freeze({ size, surfaces: Object.freeze(surfaces), pixels, fineArt });
}));
