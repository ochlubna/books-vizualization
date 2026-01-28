export const CONSPECT1_COLORS ={
    "0": "#F5D000",  // was #f2d45c — stronger yellow
    "1": "#1EB8FF",  // was #4bc8ff — punchier cyan-blue
    "2": "#FF9F1C",  // was #f1a53a — vivid orange
    "3": "#0A2FFF",  // was #0a2a7c — electric deep blue
    "5": "#1ED600",  // was #26c80c — clean bright green
    "6": "#67399f",  // was #76B7B2 — saturated teal
    "7": "#E53935",  // was #E15759 — bold red
    "8": "#FF4F81",  // was #FF9DA7 — high-chroma pink
    "9": "#557537",  // was #5d7a32 — no longer muddy olive
    "":  "#475569"   // neutral stays neutral (good choice)
};


export function hashString(str) {
    // simple stable hash
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function mulberry32(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function hexToRgb(hex) {
    const h = hex.replace("#", "").trim();
    const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
    const to = (x) => x.toString(16).padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s, l };
}

export function hslToRgb({ h, s, l }) {
    const c = (1 - Math.abs(2*l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c/2;
    let rp=0, gp=0, bp=0;

    if (0 <= h && h < 60)      { rp=c; gp=x; bp=0; }
    else if (60 <= h && h < 120){ rp=x; gp=c; bp=0; }
    else if (120 <= h && h < 180){ rp=0; gp=c; bp=x; }
    else if (180 <= h && h < 240){ rp=0; gp=x; bp=c; }
    else if (240 <= h && h < 300){ rp=x; gp=0; bp=c; }
    else                        { rp=c; gp=0; bp=x; }

    return {
        r: Math.round((rp + m) * 255),
        g: Math.round((gp + m) * 255),
        b: Math.round((bp + m) * 255)
    };
}

export function clamp01(x){ return Math.max(0, Math.min(1, x)); }

/**
 * Create a child color derived from a parent base color.
 * Deterministic: same (parentKey, childKey, depth) => same color.
 */
export function derivedColor(parentHex, parentKey, childKey, depth) {
    const k = (typeof childKey === "number" ? childKey : parseInt(childKey, 10)) % 10;

    const base = rgbToHsl(hexToRgb(parentHex));

    // Small hue offsets around parent hue (keeps "similar"),
    // but still distinct across 10 child keys.
    const H_OFF = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150];


    // Gentle S/L tweaks (help separation without changing hue too much)
    const S_OFF = [0, 0.08, -0.06, 0.06, -0.08, 0.10, -0.04, 0.04, -0.10, 0.06];
    const L_OFF = [0, 0.05, 0.03, -0.03, -0.05, 0.06, -0.06, 0.02, -0.02, 0.03];


    // Depth adds only a tiny additional shift (keeps family resemblance)
    const depthStep = Math.min(Math.max(depth - 1, 0), 3); // 0..3
    const depthHue = depthStep * 12;                         // +0..12°
    const depthSat = depthStep * 0.05;                      // +0..0.06
    const depthLit = -depthStep * 0.04;                     //  0..-0.03

    const h = (base.h + H_OFF[k] + depthHue + 360) % 360;

    // Clamp into pleasant ranges so nothing gets grey/black or neon
    const s = clamp01(
        Math.max(0.45, Math.min(0.88, base.s + S_OFF[k] + depthSat))
    );

    const l = clamp01(
        Math.max(0.30, Math.min(0.75, base.l + L_OFF[k] + depthLit))
    );

    return rgbToHex(hslToRgb({ h, s, l }));
}
