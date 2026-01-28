export const CONSPECT1_COLORS ={
    "0": "#b7cd00",
    "1": "#1EB8FF",
    "2": "#d17e00",
    "3": "#3c53ff",
    "5": "#1ED600",
    "6": "#67399f",
    "7": "#E53935",
    "8": "#FF4F81",
    "9": "#557537",
    "":  "#475569"
};

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


export function derivedColor(parentHex, parentKey, childKey, depth) {
    const k = (typeof childKey === "number" ? childKey : parseInt(childKey, 10)) % 10;

    const base = rgbToHsl(hexToRgb(parentHex));

    const H_OFF = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150];

    const S_OFF = [0, 0.08, -0.06, 0.06, -0.08, 0.10, -0.04, 0.04, -0.10, 0.06];
    const L_OFF = [0, 0.05, 0.03, -0.03, -0.05, 0.06, -0.06, 0.02, -0.02, 0.03];

    // change parameters based on depth
    const depthStep = Math.min(Math.max(depth - 1, 0), 3);
    const depthHue = depthStep * 12;
    const depthSat = depthStep * 0.05;
    const depthLit = -depthStep * 0.04;

    const h = (base.h + H_OFF[k] + depthHue + 360) % 360;

    const s = clamp01(
        Math.max(0.45, Math.min(0.88, base.s + S_OFF[k] + depthSat))
    );

    const l = clamp01(
        Math.max(0.30, Math.min(0.75, base.l + L_OFF[k] + depthLit))
    );

    return rgbToHex(hslToRgb({ h, s, l }));
}
