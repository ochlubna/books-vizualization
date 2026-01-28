import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.31.0/+esm";

import {
    BOOKS, MAP, DEFAULT, BUCKETS, NO_DATA_KEY,
    withLoading,
} from "./config.js";

import { CONSPECT1_COLORS, derivedColor } from "./colors.js";


const $ = (id) => document.getElementById(id);

const yearFromInput = $("yearFrom");
const yearToInput   = $("yearTo");
const minY = 1995, maxY = 2023;

const stat = $("stat"), err = $("err");
const tot = $("tot");

const authorsEl = $("authors");
const publishersEl = $("publishers");
const avgPagesEl = $("avgPages");
const avgAuthorsEl = $("avgAuthors");
const heading = $("heading");
const yearSliderEl = $("yearSlider");

// Language filter UI (optional if DOM not present)
const langButtonsWrap = $("langButtons");
const langOtherInput = $("langOther");
const langOtherApply = $("langOtherApply");
const langMsg = $("langMsg");

const chart = echarts.init($("chart"), null, { renderer: "canvas" });
const barChart = echarts.init($("barchart"), null, { renderer: "canvas" });
const lineChart = echarts.init($("linechart"), null, { renderer: "canvas" });

let lcHoveredSeriesName = null;
let lcAxisDataIndex = null;

let conn;

let firstRender = true;
let lastDetails = null;

let mapC1 = new Map();
let mapC2 = new Map();
let mapC3 = new Map();

let minYGlobal = null;
let maxYGlobal = null;

let stack = [{ depth: 0, c1: null, c2: null }];
let zrCenterClickHandler = null;

let slider = null;

let lineHoverSeriesName = null;
let lastLineTipDataIndex = null;

// --- Language filter state ---
const FIXED_LANGS = ["cze", "eng", "slo", "ger", "pol"]; // buttons shown in UI
let activeLanguage = "all";
let availableLanguages = new Set();

const sqlStr = (s) => String(s).replace(/'/g, "''");


const fail = (msg, ex) => {
    console.error(msg, ex);
    err.style.display = "block";
    err.textContent = msg + (ex ? " — " + (ex.message ?? ex) : "");
    stat.textContent = "ERROR";
};

const isMissing = (v) => v == null || String(v).trim() === "" || String(v).trim().toLowerCase() === "nan";
const fmt = (n) => Number(n).toLocaleString();

// Normalize values coming from CSVs: "0", "0.0", 0, "0,," -> "0"; null/"" -> ""
const normBucket = (v) => {
    if (v == null) return "";
    const s = String(v).trim();
    if (s === "") return "";
    const noCommas = s.replace(/,+$/g, "");
    const n = Number(noCommas);
    if (Number.isFinite(n)) return String(Math.trunc(n));
    return noCommas;
};

function labelFor(depth, bucket, ctx) {
    if (bucket === "") return "(bez další kategorie)";
    if (depth === 0) return mapC1.get(bucket) ?? bucket;
    if (depth === 1) return mapC2.get(`${ctx.c1}|${bucket}`) ?? bucket;
    return mapC3.get(`${ctx.c1}|${ctx.c2}|${bucket}`) ?? bucket;
}

function currentHeading(view) {
    if (view.depth === 0) return { title: "Knihy publikované v ČR" };

    const c1Name = (view.c1 === NO_DATA_KEY)
        ? "(bez další kategorie)"
        : (mapC1.get(view.c1) ?? view.c1);

    if (view.depth === 1) return { title: c1Name };

    const c2Name = (view.c2 === NO_DATA_KEY)
        ? "(bez další kategorie)"
        : (mapC2.get(`${view.c1}|${view.c2}`) ?? view.c2);

    return { title: `${c1Name} → ${c2Name}` };
}


async function loadMapping() {
    const text = await (await fetch(MAP)).text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    const rows = parsed.data ?? [];
    if (!rows.length) throw new Error("Mapping CSV parsed empty.");

    const cols = Object.keys(rows[0]);
    const c1Col = cols.find(c => /^conspect1$/i.test(c)) ?? cols[0];
    const c2Col = cols.find(c => /^conspect2$/i.test(c)) ?? cols[1];
    const c3Col = cols.find(c => /^conspect3$/i.test(c)) ?? cols[2];
    const nmCol = cols.find(c => /conspectus_name/i.test(c)) ?? cols[3];

    const m1 = new Map(), m2 = new Map(), m3 = new Map();

    for (const r of rows) {
        const c1 = normBucket(r[c1Col]);
        const c2 = normBucket(r[c2Col]);
        const c3 = normBucket(r[c3Col]);
        const name = String(r[nmCol] ?? "").trim();
        if (!name || c1 === "") continue;

        // top-level
        if (isMissing(r[c2Col]) && isMissing(r[c3Col])) m1.set(c1, name);

        // 2nd-level
        if (!isMissing(r[c2Col]) && isMissing(r[c3Col]) && c2 !== "") m2.set(`${c1}|${c2}`, name);

        // 3rd-level
        if (!isMissing(r[c2Col]) && !isMissing(r[c3Col]) && c2 !== "" && c3 !== "") m3.set(`${c1}|${c2}|${c3}`, name);
    }

    mapC1 = m1; mapC2 = m2; mapC3 = m3;
}

async function initDuckDB() {
    stat.textContent = "Init DuckDB…";
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const worker_url = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], {type:"text/javascript"}));
    const worker = new Worker(worker_url);

    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    conn = await db.connect();

    stat.textContent = "Načítání datasetu…";
    const resp = await fetch(BOOKS);
    if (!resp.ok) throw new Error(`Fetch failed for ${BOOKS}: HTTP ${resp.status}`);
    await db.registerFileBuffer(BOOKS, new Uint8Array(await resp.arrayBuffer()));
    // After: await db.registerFileBuffer(...)

    stat.textContent = "Preparing table…";

    await conn.query(`
  CREATE TEMP TABLE books_t AS
  SELECT
    CAST(start_interval_year AS INT) AS s_year,
    CAST(end_interval_year   AS INT) AS e_year,
    LOWER(TRIM(CAST(language  AS VARCHAR))) AS language,
    TRIM(CAST(conspect1 AS VARCHAR)) AS conspect1,
    TRIM(CAST(conspect2 AS VARCHAR)) AS conspect2,
    TRIM(CAST(conspect3 AS VARCHAR)) AS conspect3,
    CAST(books AS BIGINT) AS books,
    CAST(authors AS BIGINT) AS authors,
    CAST(publishers AS BIGINT) AS publishers,
    CAST(pages AS BIGINT) AS pages,
    CAST(avg_authors_per_book AS DOUBLE) AS avg_authors_per_book
  FROM read_csv_auto('${BOOKS}')
`);

}

async function yearBounds() {
    const q = `
            SELECT MIN(CAST(start_interval_year AS INT)) minY,
                   MAX(CAST(end_interval_year   AS INT)) maxY
            FROM read_csv_auto('${BOOKS}')
            WHERE language='all'
        `;
    const r = (await conn.query(q)).toArray()[0];
    return { minY: Number(r.minY), maxY: Number(r.maxY) };
}

function initYearInputs(minY, maxY) {
    const s0 = Math.max(minY, Math.min(maxY, DEFAULT.s));
    const e0 = Math.max(minY, Math.min(maxY, DEFAULT.e));

    yearFromInput.value = String(s0);
    yearToInput.value   = String(e0);
}

function initYearSlider(minY, maxY) {
    const s0 = +yearFromInput.value;
    const e0 = +yearToInput.value;

    if (slider) {
        slider.destroy();
        slider = null;
    }

    slider = noUiSlider.create(yearSliderEl, {
        start: [s0, e0],
        connect: true,
        step: 1,
        range: { min: minY, max: maxY },
        tooltips: [true, true],
        format: {
            to: (v) => String(Math.round(v)),
            from: (v) => Number(v)
        }
    });

    // live update (don’t refresh on every move)
    slider.on("update", (values) => {
        const a = +values[0], b = +values[1];
        const s = Math.min(a, b);
        const e = Math.max(a, b);
        yearFromInput.value = String(s);
        yearToInput.value   = String(e);
    });

    // refresh only when user releases handle
    slider.on("set", () => {
        resetAll();
    });
}

function clampYear(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(minY, Math.min(maxY, n));
}

function syncInputsToSlider() {
    const a = clampYear(yearFromInput.value);
    const b = clampYear(yearToInput.value);
    if (a == null || b == null) return;

    const s = Math.min(a, b);
    const e = Math.max(a, b);

    // This triggers slider's "set" event => resetAll()
    slider.set([s, e]);
}

yearFromInput.addEventListener("change", syncInputsToSlider);
yearToInput.addEventListener("change", syncInputsToSlider);


async function loadLanguages() {
    const q = `
        SELECT DISTINCT TRIM(CAST(language AS VARCHAR)) AS language
        FROM read_csv_auto('${BOOKS}')
        WHERE language IS NOT NULL AND TRIM(CAST(language AS VARCHAR)) != ''
    `;

    const res = await conn.query(q);
    const set = new Set();
    for (const r of res.toArray()) {
        const l = String(r.language ?? '').trim().toLowerCase();
        if (l) set.add(l);
    }
    availableLanguages = set;
}

function setActiveLanguage(lang, { silent = false } = {}) {
    const l = String(lang ?? '').trim().toLowerCase();
    if (!l) return;

    if (l === activeLanguage) {activeLanguage = 'all'}
    else {activeLanguage = l;}
    try { localStorage.setItem('lang', activeLanguage); } catch {}
    updateLanguageUI();
    if (!silent) {
        withLoading(async () => {
            await refresh();
        });
    }
}

function updateLanguageUI() {
    if (!langButtonsWrap) return;

    // highlight buttons
    for (const btn of langButtonsWrap.querySelectorAll('button[data-lang]')) {
        const l = btn.getAttribute('data-lang')?.toLowerCase();
        btn.classList.toggle('active', l === activeLanguage);
    }

    // message
    if (langMsg) {
        if (activeLanguage === 'all') langMsg.textContent = '';
        else langMsg.textContent = `Filtr: ${activeLanguage}`;
    }
}

function initLanguageUI() {
    if (!langButtonsWrap) return;

    // button clicks
    langButtonsWrap.addEventListener('click', (ev) => {
        const btn = ev.target?.closest?.('button[data-lang]');
        if (!btn) return;
        const l = btn.getAttribute('data-lang');
        setActiveLanguage(l);
    });

    const applyOther = () => {
        if (!langOtherInput) return;
        const raw = String(langOtherInput.value ?? '').trim().toLowerCase();
        if (!raw) return;

        if (!availableLanguages || availableLanguages.size === 0) {
            // languages not loaded yet: accept, but might yield 0 results
            setActiveLanguage(raw);
            return;
        }
        if (!availableLanguages.has(raw)) {
            if (langMsg) langMsg.textContent = `Unknown language: ${raw}`;
            return;
        }
        setActiveLanguage(raw);
    };

    if (langOtherApply) langOtherApply.addEventListener('click', applyOther);
    if (langOtherInput) {
        langOtherInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyOther();
            }
        });
    }

    updateLanguageUI();
}

async function queryBucketsForView(s, e, view, lang = activeLanguage) {
    const col = view.depth === 0 ? "conspect1" : view.depth === 1 ? "conspect2" : "conspect3";
    const filters = [
        `language='${sqlStr(lang)}'`,
        `CAST(start_interval_year AS INT) = ${s}`,
        `CAST(end_interval_year   AS INT) = ${e}`
    ];

    if (view.depth >= 1) filters.push(`TRIM(CAST(conspect1 AS VARCHAR)) = '${view.c1}'`);
    if (view.depth >= 2) filters.push(`TRIM(CAST(conspect2 AS VARCHAR)) = '${view.c2}'`);

    const q = `
            WITH base AS (
                SELECT TRIM(CAST(${col} AS VARCHAR)) AS v, books
                FROM read_csv_auto('${BOOKS}')
                WHERE ${filters.join(" AND ")}
            ),
            bucketed AS (
                SELECT
                    CASE
                        WHEN v IS NULL OR v = '' THEN ''
                        WHEN v ~ '^[0-9]$' THEN v
                        WHEN v ~ '^[0-9]\\.0$' THEN LEFT(v, 1)
                        ELSE NULL
                    END AS b,
                    books
                FROM base
            )
            SELECT b AS bucket, SUM(books) AS books
            FROM bucketed
            WHERE b IS NOT NULL
            GROUP BY b
        `;

    const rows = (await conn.query(q)).toArray().map(r => ({
        key: String(r.bucket ?? ""),
        value: Number(r.books ?? 0)
    }));

    const m = new Map(rows.map(d => [d.key, d.value]));
    return BUCKETS
        .map(k => ({ key: k, value: m.get(k) ?? 0 }))
        .filter(d => d.value > 0);
}

async function queryDetailsForSelection(s, e, view, lang = activeLanguage) {
    const filters = [
        `language='${sqlStr(lang)}'`,
        `CAST(start_interval_year AS INT) = ${s}`,
        `CAST(end_interval_year   AS INT) = ${e}`
    ];

    if (view.depth >= 1) filters.push(`TRIM(CAST(conspect1 AS VARCHAR)) = '${sqlStr(view.c1)}'`);
    if (view.depth >= 2) filters.push(`TRIM(CAST(conspect2 AS VARCHAR)) = '${sqlStr(view.c2)}'`);

    // avg_authors_per_book je už "průměr na knihu" v datasetu,
    // takže pro agregaci přes více řádků děláme vážený průměr podle počtu knih.
    const q = `
    SELECT
      SUM(books)        AS books,
      SUM(authors)      AS authors,
      SUM(publishers)   AS publishers,
      SUM(pages)        AS pages,
      CASE WHEN SUM(books) > 0
        THEN SUM(avg_authors_per_book * books) / SUM(books)
        ELSE NULL
      END AS avg_authors_per_book_weighted
    FROM read_csv_auto('${BOOKS}')
    WHERE ${filters.join(" AND ")}
  `;

    const row = (await conn.query(q)).toArray()[0] ?? {};
    return {
        books: Number(row.books ?? 0),
        authors: Number(row.authors ?? 0),
        publishers: Number(row.publishers ?? 0),
        pages: Number(row.pages ?? 0),
        avg_authors_per_book: row.avg_authors_per_book_weighted == null ? null : Number(row.avg_authors_per_book_weighted)
    };
}


async function queryBooksPerYear(s, e, view, lang = activeLanguage) {
    const filters = [
        `language='${sqlStr(lang)}'`,
        `CAST(start_interval_year AS INT) >= ${s}`,
        `CAST(start_interval_year AS INT) <= ${e}`,
        `start_interval_year = end_interval_year`
    ];

    if (view.depth === 0) {
        filters.push(`TRIM(CAST(conspect1 AS VARCHAR)) != '' AND conspect1 IS NOT NULL`);
    } else {
        filters.push(`TRIM(CAST(conspect1 AS VARCHAR)) = '${view.c1}'`);
        if (view.depth >= 2) {
            filters.push(`TRIM(CAST(conspect2 AS VARCHAR)) = '${view.c2}'`);
        }
    }

    const q = `
        SELECT
            CAST(start_interval_year AS INT) AS year,
            SUM(books) AS books
        FROM read_csv_auto('${BOOKS}')
        WHERE ${filters.join(" AND ")}
        GROUP BY year
        ORDER BY year
    `;

    const res = await conn.query(q);
    return res.toArray().map(r => ({
        year: Number(r.year),
        value: Number(r.books)
    }));
}

async function queryLinesForView(s, e, view, lang = activeLanguage) {
    const targetCol = view.depth === 0 ? 'conspect1' : (view.depth === 1 ? 'conspect2' : 'conspect3');

    const filters = [
        `language='${sqlStr(lang)}'`,
        `CAST(start_interval_year AS INT) >= ${s}`,
        `CAST(start_interval_year AS INT) <= ${e}`,
        `start_interval_year = end_interval_year`,
        `TRIM(CAST(${targetCol} AS VARCHAR)) != '' AND ${targetCol} IS NOT NULL`,
        `TRIM(CAST(${targetCol} AS VARCHAR)) != 'all'`
    ];

    if (view.depth >= 1) filters.push(`TRIM(CAST(conspect1 AS VARCHAR)) = '${view.c1}'`);
    if (view.depth >= 2) filters.push(`TRIM(CAST(conspect2 AS VARCHAR)) = '${view.c2}'`);

    const q = `
        SELECT 
            CAST(start_interval_year AS INT) as year,
            TRIM(CAST(${targetCol} AS VARCHAR)) as category,
            SUM(books) as books
        FROM read_csv_auto('${BOOKS}')
        WHERE ${filters.join(" AND ")}
        GROUP BY year, category
        ORDER BY year ASC
    `;

    const res = await conn.query(q);
    return res.toArray().map(r => ({
        year: Number(r.year),
        category: normBucket(r.category),
        value: Number(r.books)
    }));
}

async function queryLanguageTotalsForSelection(s, e, view, languages) {
    const col = view.depth === 0 ? "conspect1" : view.depth === 1 ? "conspect2" : "conspect3";

    const langs = Array.from(new Set(languages.map(l => String(l).trim().toLowerCase()).filter(Boolean)));
    if (!langs.length) return new Map();

    const filters = [
        `CAST(start_interval_year AS INT) = ${s}`,
        `CAST(end_interval_year   AS INT) = ${e}`
    ];

    if (view.depth >= 1) filters.push(`TRIM(CAST(conspect1 AS VARCHAR)) = '${sqlStr(view.c1)}'`);
    if (view.depth >= 2) filters.push(`TRIM(CAST(conspect2 AS VARCHAR)) = '${sqlStr(view.c2)}'`);

    const inList = langs.map(l => `'${sqlStr(l)}'`).join(",");

    const q = `
        WITH base AS (
            SELECT
                TRIM(CAST(language AS VARCHAR)) AS language,
                TRIM(CAST(${col} AS VARCHAR)) AS v,
                books
            FROM read_csv_auto('${BOOKS}')
            WHERE ${filters.join(" AND ")}
              AND TRIM(CAST(language AS VARCHAR)) IN (${inList})
        ),
        bucketed AS (
            SELECT
                language,
                CASE
                    WHEN v IS NULL OR v = '' THEN ''
                    WHEN v ~ '^[0-9]$' THEN v
                    WHEN v ~ '^[0-9]\\.0$' THEN LEFT(v, 1)
                    ELSE NULL
                END AS b,
                books
            FROM base
        )
        SELECT language, SUM(books) AS books
        FROM bucketed
        WHERE b IS NOT NULL
        GROUP BY language
    `;

    const rows = (await conn.query(q)).toArray();
    const m = new Map();
    for (const r of rows) {
        const l = String(r.language ?? '').trim().toLowerCase();
        m.set(l, Number(r.books ?? 0));
    }
    // ensure keys exist with 0
    for (const l of langs) if (!m.has(l)) m.set(l, 0);
    return m;
}

function updateLanguagePercentages(langStats) {
    // Supports both Map (preferred) and plain object.
    const get = (k) => {
        if (!langStats) return 0;
        if (langStats instanceof Map) return Number(langStats.get(k) ?? 0);
        return Number(langStats[k] ?? 0);
    };

    const totalAll = get('all');

    document.querySelectorAll(".langPct").forEach(el => {
        const lang = (el.dataset.pctFor ?? '').toLowerCase();

        let pct;
        if (activeLanguage !== "all") {
            pct = (lang === activeLanguage) ? 100 : 0;
        } else {
            const num = get(lang);
            pct = totalAll > 0 ? Math.round((num / totalAll) * 1000)/10 : 0;
        }

        el.textContent = `${pct}%`;
    });
}




function updateSide(s, e, view, total) {
    tot.textContent = fmt(total);

    const h = currentHeading(view);
    heading.textContent = h.title;
}

function updateDetails(d) {
    if (!d || !d.books) {
        authorsEl.textContent = "—";
        publishersEl.textContent = "—";
        avgPagesEl.textContent = "—";
        avgAuthorsEl.textContent = "—";
        return;
    }

    authorsEl.textContent = fmt(d.authors);
    publishersEl.textContent = fmt(d.publishers);

    const avgPages = d.pages / d.books;
    avgPagesEl.textContent = `${avgPages.toFixed(0)}`;

    // buď přímo z datasetu (avg_authors_per_book), nebo váženě spočítané v dotazu
    avgAuthorsEl.textContent = `${Number(d.avg_authors_per_book).toFixed(2)}`;

}


function setCenterBackHandler() {
    const zr = chart.getZr();
    if (zrCenterClickHandler) zr.off("click", zrCenterClickHandler);

    zrCenterClickHandler = (ev) => {
        if (stack.length <= 1) return;

        const w = chart.getWidth(), h = chart.getHeight();
        const cx = w / 2, cy = h / 2;
        const dx = ev.offsetX - cx, dy = ev.offsetY - cy;
        const dist = Math.sqrt(dx*dx + dy*dy);

        const R = Math.min(w, h) / 2;
        const inner = R * 0.55;

        if (dist <= inner) {
            withLoading(async () => {
                stack.pop();
                await refresh();
            });
        }

    };

    zr.on("click", zrCenterClickHandler);
}

function renderChart(data, s, e, view) {
    const css = getComputedStyle(document.body);
    const chartBorder = css.getPropertyValue("--chart-border").trim();
    const labelColor  = css.getPropertyValue("--text").trim();
    const mutedColor  = css.getPropertyValue("--muted").trim();
    const centerFill  = css.getPropertyValue("--center-fill").trim();
    const centerStroke= css.getPropertyValue("--center-stroke").trim();

    const total = data.reduce((a,d)=>a+d.value,0);
    updateSide(s, e, view, total);

    chart.setOption({
        backgroundColor: "transparent",
        animation: true,
        animationDurationUpdate: 350,
        tooltip: {
            trigger: "item",
            formatter: (p) => `${p.name}<br/>${fmt(p.value)} knih (${p.percent}%)`
        },
        series: [{
            type: "pie",
            radius: ["55%", "85%"],
            minShowLabelAngle: 10,
            itemStyle: { borderColor: chartBorder, borderWidth: 2 },
            label: {
                color: labelColor,
                fontSize: 11,
                formatter: (p) => `${p.name}\n${fmt(p.value)}`
            },
            labelLine: { lineStyle: { color: mutedColor  } },
            data: data.map(d => {
                const key = d.key;

                // base color always comes from conspect1 selection:
                // depth 0: slice IS conspect1 key
                // depth 1/2: parent conspect1 is view.c1
                const parentC1 = (view.depth === 0) ? key : view.c1;
                const base = CONSPECT1_COLORS[parentC1] ?? "#64748b";

                let color = base;

                // derive colors for lower layers
                if (view.depth >= 1) {
                    // depth 1: vary by conspect2 key
                    // depth 2: vary by conspect3 key (still anchored to conspect1 base)
                    color = derivedColor(base, parentC1, key, view.depth);
                }

                return {
                    name: labelFor(view.depth, key, view),
                    value: d.value,
                    key,
                    itemStyle: { color }
                };
            })
        }],
        graphic: [{
            type: "group",
            left: "center",
            top: "middle",
            silent: true,
            children: [
                { type: "circle", shape: { r: 70 }, style: { fill: centerFill, stroke: centerStroke, lineWidth: 1 } },
                { type: "text", style: { text: (stack.length > 1 ? "◀ zpět" : "zvol kategorii"), fill: mutedColor, font: "12px system-ui", align: "center", verticalAlign: "middle" }, x: 0, y: 0 }
            ]
        }]
    }, true);

    if (firstRender) {
        document.getElementById("loading").style.display = "none";
        firstRender = false;
    }

    chart.off("click");
    chart.on("click", (params) => {
        const key = params?.data?.key;
        if (key == null) return;
        if (key === NO_DATA_KEY) return;

        const cur = stack[stack.length - 1];

        if (cur.depth === 0) {
            withLoading(async () => {
                stack.push({ depth: 1, c1: key, c2: null });
                await refresh();
            });
        } else if (cur.depth === 1) {
            withLoading(async () => {
                stack.push({ depth: 2, c1: cur.c1, c2: key });
                await refresh();
            });
        }
    });


    setCenterBackHandler();
    stat.textContent = `Interval ${s}–${e}\r\nHloubka ${view.depth}`;
}

function renderBarChart(rows, view) {
    const css = getComputedStyle(document.body);
    const mutedColor = css.getPropertyValue("--muted").trim();

    let barColor = "#3b82f6";
    if (view.depth >= 1) {
        barColor = CONSPECT1_COLORS[view.c1] ?? barColor;
    }

    barChart.setOption({
        backgroundColor: "transparent",
        title: {
            text: 'Vydané knihy',
            left: 12,
            top: 6,
            textStyle: {
                fontSize: 12,
                fontWeight: 600,
                color: getComputedStyle(document.body)
                    .getPropertyValue('--muted')
            }
        },
        grid: { top: 50, right: 20, bottom: 40, left: 60 },
        tooltip: {
            trigger: "axis",
            formatter: (params) => `<b>${params[0].name}</b><br/>${fmt(params[0].value)} knih`
        },
        xAxis: {
            type: "category",
            data: rows.map(d => d.year),
            axisLabel: { color: mutedColor, fontSize: 10 }
        },
        yAxis: {
            type: "value",
            axisLabel: { color: mutedColor, fontSize: 10 },
            splitLine: { lineStyle: { opacity: 0.1 } }
        },
        series: [{
            type: "bar",
            data: rows.map(d => d.value),
            itemStyle: { color: barColor, borderRadius: [4, 4, 0, 0] },
            emphasis: { itemStyle: { opacity: 0.8 } }
        }]
    }, true);
}

function renderLineChart(rows, view) {
    const css = getComputedStyle(document.body);
    const mutedColor = css.getPropertyValue("--muted").trim();

    const years = [...new Set(rows.map(d => d.year))].sort((a, b) => a - b);
    const categories = [...new Set(rows.map(d => d.category))];

    const byCat = new Map();
    for (const { year, category, value } of rows) {
        if (!byCat.has(category)) byCat.set(category, new Map());
        byCat.get(category).set(year, value);
    }

    const series = categories.map(cat => {
        let color;
        if (view.depth === 0) {
            color = CONSPECT1_COLORS[cat] ?? "#64748b";
        } else {
            const base = CONSPECT1_COLORS[view.c1] ?? "#64748b";
            color = derivedColor(base, view.c1, cat, view.depth);
        }

        return {
            name: labelFor(view.depth, cat, view),
            type: "line",
            smooth: true,
            symbol: "none",
            lineStyle: { width: 2 },
            emphasis: { focus: "series" },
            itemStyle: { color },
            data: years.map(y => byCat.get(cat)?.get(y) ?? 0)
        };
    });

    // --- NEW: keep track of which line is currently hovered ---
    // Put this near the top-level of your file if you prefer, but this works too.
    if (!renderLineChart._hover) renderLineChart._hover = { seriesName: null };
    const hoverState = renderLineChart._hover;

    lineChart.setOption({
        backgroundColor: "transparent",
        animation: true,
        title: {
            text: "Popularita jednotlivých podkategorií",
            left: 12,
            top: 6,
            textStyle: {
                fontSize: 12,
                fontWeight: 600,
                color: getComputedStyle(document.body).getPropertyValue("--muted")
            }
        },
        grid: { top: 50, right: 20, bottom: 40, left: 60 },
        legend: categories.length <= 6
            ? { bottom: 0, textStyle: { color: mutedColor } }
            : undefined,
        tooltip: {
            trigger: "axis",
            renderMode: "html",
            appendToBody: true,
            formatter: (params) => {
                if (!params?.length) return "";

                const year = params[0].axisValue;

                const rows = params.map(p => {
                    const isHover = lcHoveredSeriesName && p.seriesName === lcHoveredSeriesName;

                    const name = isHover
                        ? `<span style="font-weight:800;text-decoration:underline">${escapeHtml(p.seriesName)}</span>`
                        : escapeHtml(p.seriesName);

                    return `<div>${p.marker}${name}: ${fmt(p.value)}</div>`;
                }).join("");

                return `<b>${escapeHtml(String(year))}</b><br/>${rows}`;
            }
        },
        xAxis: {
            type: "category",
            data: years,
            axisLabel: { color: mutedColor, fontSize: 10 },
            axisLine: { lineStyle: { color: mutedColor, opacity: 0.4 } }
        },
        yAxis: {
            type: "value",
            axisLabel: { color: mutedColor, fontSize: 10 },
            splitLine: { lineStyle: { opacity: 0.1 } }
        },
        series
    }, true);

    lineChart.off("updateAxisPointer");

    lineChart.on("updateAxisPointer", (e) => {
        const info = e?.axesInfo?.[0];
        if (!info) return;

        // index on x-axis
        lcAxisDataIndex = info.value; // for category axis this is usually the category value
        // BUT we need dataIndex; seriesData[0].dataIndex is safest when present:
        const sd = info.seriesData;

        if (sd && sd.length) {
            // Pick the series "under" the pointer. If multiple, you can choose max value etc.
            lcHoveredSeriesName = sd[0].seriesName;

            // Force re-render tooltip so formatter runs with updated lcHoveredSeriesName
            lineChart.dispatchAction({
                type: "showTip",
                seriesIndex: sd[0].seriesIndex,
                dataIndex: sd[0].dataIndex
            });
        }
    });
}


async function refresh() {
    err.style.display = "none";
    const s = +yearFromInput.value, e = +yearToInput.value;
    const view = stack[stack.length - 1];

    stat.textContent = `Query: ${s}–${e}\r\nHloubka ${view.depth}…`;

    const langsForPct = [...FIXED_LANGS, "all", activeLanguage];

    const [pieRows, barRows, lineRows, langTotals, details] = await Promise.all([
        queryBucketsForView(s, e, view, activeLanguage),
        queryBooksPerYear(s, e, view, activeLanguage),
        queryLinesForView(s, e, view, activeLanguage),
        queryLanguageTotalsForSelection(s, e, view, langsForPct),
        queryDetailsForSelection(s, e, view, activeLanguage),
    ]);

    // language UI always
    updateLanguagePercentages(langTotals);

    // details + header always (even if charts have no rows)
    lastDetails = details;

    const totalBooks = Number(details?.books ?? 0);
    updateSide(s, e, view, totalBooks);   // interval + total + heading
    updateDetails(details);               // <-- NEW: fill authors/publishers/avg/illustrated

    // no data: clear charts but keep UI consistent
    if (!pieRows.length) {
        chart.clear();
        barChart.clear();
        lineChart.clear();
        lastDetails = null;
        updateDetails(null);                // <-- NEW: set — everywhere
        stat.textContent = "No data";
        return;
    }

    renderChart(pieRows, s, e, view);
    renderBarChart(barRows, view);
    renderLineChart(lineRows, view);
}


function resetAll() {
    withLoading(async () => {
        stack = [{ depth: 0, c1: null, c2: null }];
        await refresh();
    });
}

function renderYearTicks(minY, maxY) {
    const ticksEl = document.getElementById("yearTicks");
    if (!ticksEl) return;
    ticksEl.innerHTML = "";

    for (let y = minY; y <= maxY; y++) {
        if (y % 10 !== 0 && y !== minY && y !== maxY) continue; // only decades
        const span = document.createElement("span");
        span.className = "yearTick";
        span.textContent = String(y);

        const pct = ((y - minY) / (maxY - minY)) * 100;
        span.style.left = pct + "%";
        ticksEl.appendChild(span);
    }
}

function isLight() {
    return document.body.classList.contains("light");
}

function applyTheme(light) {
    withLoading(async () => {
        document.body.classList.toggle("light", !!light);

        try {
            localStorage.setItem("theme", light ? "light" : "dark");
        } catch {}

        await refresh();
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
}

(async () => {
    try {
        stat.textContent = "Loading mapping…";
        await loadMapping();

        initLanguageUI();

        await initDuckDB();
        await loadLanguages();

        // restore language preference if possible
        try {
            const storedLang = localStorage.getItem('lang');
            if (storedLang) {
                const l = storedLang.trim().toLowerCase();
                if (!availableLanguages.size || availableLanguages.has(l)) {
                    setActiveLanguage(l, { silent: true });
                }
            }
        } catch {}
        const { minY, maxY } = await yearBounds();
        minYGlobal = minY;
        maxYGlobal = maxY;

        initYearInputs(minY, maxY);
        initYearSlider(minY, maxY);

        if (minYGlobal != null) renderYearTicks(minYGlobal, maxYGlobal);

        let stored = null;
        try { stored = localStorage.getItem("theme"); } catch {}
        applyTheme(stored === "light");

        $("themeToggle").onclick = () => applyTheme(!isLight());


        $("reset").onclick = () => {
            // reset slider + drill stack
            const s0 = Math.max(minY, Math.min(maxY, DEFAULT.s));
            const e0 = Math.max(minY, Math.min(maxY, DEFAULT.e));
            slider.set([s0, e0]); // triggers resetAll via 'set'
        };

        await resetAll();
    } catch (e) {
        fail("App crashed during init", e);
    }
})();

window.addEventListener("resize", () => {
    chart.resize();
    barChart.resize();
    lineChart.resize();
    setCenterBackHandler();
    if (minYGlobal != null) renderYearTicks(minYGlobal, maxYGlobal);
});
