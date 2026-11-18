(function (root, factory) {
  "use strict";
  const plotter = factory();
  if (typeof module === "object" && module.exports) module.exports = plotter;
  else root.GrabenplanerBranchPlotter = plotter;
}(globalThis, function () {
  "use strict";

  const dimensions = Object.freeze({ width: 1.110, depth: .984, height: 1.168 });
  const source = "https://ij.manual.canon/ij/webmanual/Manual/All/PRO-2000/EN/LBGB/tp000183.html";
  const color = {
    case: [.178, .183, .189], hood: [.236, .242, .249], ink: [.178, .186, .194],
    seam: [.06, .065, .071], steel: [.144, .155, .161], axle: [.28, .294, .303],
    rubber: [.056, .06, .064], cloth: [.087, .093, .096], accent: [.67, .053, .072],
  };
  const tint = (rgb, factor) => rgb.map(value => value * factor);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalize = vector => {
    const length = Math.hypot(...vector);
    return vector.map(value => value / length);
  };

  function add(mesh, x, z, artwork) {
    const at = ([px, py, pz]) => [x + px, py, z + pz];
    const tri = (a, b, c, rgb) => mesh.tri(at(a), at(b), at(c), rgb);
    const quad = (a, b, c, d, rgb) => mesh.quad(at(a), at(b), at(c), at(d), rgb);
    const box = (px, py, pz, w, h, d, rgb) => mesh.box(x + px, py, z + pz, w, h, d, rgb);
    const label = (text, points, theme) => mesh.label(text, ...points.map(at), theme);

    // Convex cross sections with bevels at both ends keep the body rounded
    // from the side as well as from the front.
    function housing(left, right, outline, rgb, bevel = .014) {
      const middle = outline.reduce(([y, depth], p) => [y + p[0] / outline.length, depth + p[1] / outline.length], [0, 0]);
      const rim = outline.map(([y, depth]) => [y + (middle[0] - y) * .048, depth + (middle[1] - depth) * .048]);
      const rings = [[left, rim], [left + bevel, outline], [right - bevel, outline], [right, rim]];
      for (let i = 0; i < outline.length; i += 1) {
        const next = (i + 1) % outline.length;
        const dy = outline[next][0] - outline[i][0], dz = outline[next][1] - outline[i][1];
        const light = Math.max(0, (-dz * .88 + dy * .48) / Math.hypot(dy, dz));
        for (let ring = 0; ring < 3; ring += 1) {
          const [ax, a] = rings[ring], [bx, b] = rings[ring + 1];
          quad([ax, ...a[i]], [bx, ...b[i]], [bx, ...b[next]], [ax, ...a[next]],
            tint(rgb, .68 + .32 * light + (ring === 1 ? 0 : .065)));
        }
        tri([left, ...middle], [left, ...rim[i]], [left, ...rim[next]], tint(rgb, .69));
        tri([right, ...middle], [right, ...rim[next]], [right, ...rim[i]], tint(rgb, .83));
      }
    }

    function tube(a, b, radius, rgb, segments = 20) {
      const axis = normalize(b.map((value, i) => value - a[i]));
      const u = normalize(cross(axis, Math.abs(axis[1]) > .92 ? [0, 0, 1] : [0, 1, 0]));
      const v = cross(axis, u);
      const ring = index => {
        const theta = index / segments * 2 * Math.PI;
        return u.map((value, i) => value * Math.cos(theta) + v[i] * Math.sin(theta));
      };
      const edge = (center, normal) => center.map((value, i) => value + normal[i] * radius);
      for (let i = 0; i < segments; i += 1) {
        const n = ring(i), m = ring(i + 1);
        const aa = edge(a, n), ab = edge(a, m), ba = edge(b, n), bb = edge(b, m);
        quad(aa, ba, bb, ab, tint(rgb, .68 + .35 * Math.max(0, n[1] * .76 + n[2] * .46 - n[0] * .25)));
        tri(a, ab, aa, tint(rgb, .89));
        tri(b, ba, bb, tint(rgb, .78));
      }
    }

    // SD-21 stand, with paired wheels at every caster and a cross brace.
    for (const center of [.126, .984]) {
      housing(center - .061, center + .061,
        [[.071, .018], [.071, .719], [.096, .751], [.126, .745], [.139, .244], [.119, .033]], color.steel, .012);
      housing(center - .046, center + .046,
        [[.108, .139], [.108, .256], [.556, .288], [.567, .172]], color.steel, .008);
      for (const depth of [.06, .703]) {
        box(center - .018, .061, depth - .016, .036, .024, .032, color.axle);
        for (const offset of [-.031, .005]) {
          tube([center + offset, .05, depth], [center + offset + .025, .05, depth], .029, color.rubber);
        }
        tube([center - .033, .05, depth], [center + .032, .05, depth], .012, color.axle, 12);
      }
    }
    box(.144, .385, .188, .823, .065, .05, color.steel);
    box(.143, .51, .135, .826, .051, .17, color.seam);

    // Recessed output cavity, flanked by rounded end shells.
    housing(.018, 1.092, [[.54, .096], [.54, .495], [.592, .585], [.872, .598],
      [1.089, .524], [1.095, .14], [1.074, .048], [.991, .012], [.649, .012]], color.case);
    const cheek = [[.541, .105], [.541, .597], [.56, .663], [.617, .71], [.703, .734],
      [.951, .732], [1.025, .701], [1.085, .602], [1.094, .105], [1.066, .028], [.979, 0], [.636, 0]];
    housing(0, .186, cheek, color.case, .018);
    housing(.925, 1.110, cheek, tint(color.case, 1.05), .018);
    box(.175, .64, .575, .763, .237, .125, color.seam);
    housing(.174, .937, [[.854, .132], [.854, .700], [.864, .722], [.89, .734],
      [1.007, .723], [1.061, .688], [1.091, .604], [1.097, .167], [1.083, .137]], color.hood, .012);
    box(.19, .875, .724, .73, .006, .008, color.accent);
    label("Canon", [[.474, .937, .731], [.632, .937, .731], [.632, .973, .729], [.474, .973, .729]], "canon");
    label("PRO-2000", [[.028, .947, .734], [.154, .947, .734], [.154, .974, .728], [.028, .974, .728]], "model");

    for (const [left, right] of [[.072, .429], [.698, 1.061]]) {
      housing(left - .009, right + .009, [[1.075, .055], [1.075, .352], [1.117, .325],
        [1.139, .280], [1.139, .075], [1.122, .051]], color.seam, .010);
      housing(left, right, [[1.101, .057], [1.101, .333], [1.147, .309],
        [1.168, .268], [1.168, .104], [1.153, .063]], color.ink, .014);
      for (let start = left + .036; start < right - .047; start += .065) {
        box(start, 1.163, .146, .042, .005, .046, color.seam);
      }
    }
    box(.961, .619, .724, .114, .122, .009, tint(color.case, .72));
    box(.964, .624, .733, .108, .111, .001, tint(color.case, .93));
    box(.989, .724, .733, .052, .006, .001, color.seam);

    // Recessed glass on the sloped right control panel.
    const control = [[.931, 1.019, .710], [1.086, 1.019, .710], [1.086, 1.082, .604], [.931, 1.082, .604]];
    quad(...control, color.seam);
    label("Status", [[.955, 1.032, .695], [1.048, 1.032, .695], [1.048, 1.064, .642], [.955, 1.064, .642]], "printer-screen");
    quad([1.057, 1.039, .683], [1.071, 1.039, .683], [1.071, 1.049, .665], [1.057, 1.049, .665], [.36, .59, .43]);
    box(1.032, .958, .725, .025, .009, .004, color.seam);

    tube([.196, .794, .708], [.916, .794, .708], .019, color.rubber);
    for (const offset of [.213, .899]) {
      tube([offset - .008, .794, .708], [offset + .016, .794, .708], .021, color.axle, 14);
    }
    housing(.188, .925, [[.637, .589], [.637, .706], [.662, .724],
      [.724, .718], [.753, .689], [.745, .629]], [.201, .216, .225], .012);
    for (let start = .223; start < .91; start += .073) {
      box(start, .73, .695, .003, .015, .011, tint(color.case, .69));
    }

    // Open cloth catch basket: rails and diagonal brackets hold a sagging fabric span.
    const basket = [[.419, .297], [.345, .369], [.268, .457], [.212, .554],
      [.191, .655], [.207, .756], [.257, .849], [.343, .923], [.453, .971]];
    for (let i = 0; i < basket.length - 1; i += 1) {
      const a = basket[i], b = basket[i + 1];
      quad([.133, ...a], [.977, ...a], [.977, ...b], [.133, ...b], tint(color.cloth, .77 + i * .031));
    }
    for (const rail of [basket[0], basket.at(-1)]) {
      tube([.102, ...rail], [1.008, ...rail], .013, color.steel);
    }
    for (const bracket of [.105, 1.005]) {
      tube([bracket, .15, .302], [bracket, .450, .968], .009, color.axle, 12);
      tube([bracket, .436, .967], [bracket, .468, .967], .011, color.rubber, 12);
    }

    // Paper follows a curved path over the guide into the basket.
    const paper = [[.787, .727], [.746, .744], [.671, .761], [.592, .783],
      [.508, .814], [.427, .851], [.371, .891], [.344, .929]];
    for (let i = 0; i < paper.length - 1; i += 1) {
      const v0 = i / (paper.length - 1), v1 = (i + 1) / (paper.length - 1);
      mesh.texturedQuad(artwork, [
        at([.249, ...paper[i]]), at([.860, ...paper[i]]),
        at([.860, ...paper[i + 1]]), at([.249, ...paper[i + 1]]),
      ], [[0, v0], [1, v0], [1, v1], [0, v1]]);
    }
  }

  return Object.freeze({ dimensions, source, add });
}));
