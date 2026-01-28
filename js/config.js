export const BOOKS = "books_aggregated.csv";
export const MAP   = "conspectus_mapping.csv";
export const DEFAULT = { s: 1995, e: 2023 };
export const BUCKETS = ["", "0","1","2","3","4","5","6","7","8","9"];
export const INNER_RADIUS_PCT = 0.55; // must match series.radius inner percent ("55%")
export const NO_DATA_KEY = "";        // empty bucket

export const LOADING_DELAY = 1000;

export function showLoading() {
    document.getElementById("loading").style.display = "flex";
}

export function hideLoading() {
    document.getElementById("loading").style.display = "none";
}

export function withLoading(action) {
    showLoading();
    setTimeout(async () => {
        await action();
        hideLoading();
    }, LOADING_DELAY);
}
