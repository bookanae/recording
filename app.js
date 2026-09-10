/*
 * Reel & Places
 * サーバーを使わず、映画・場所・履歴をこのブラウザの IndexedDB に保存します。
 * UIの更新は renderAll() に集約し、後から追いやすい構成にしています。
 */

const DB_NAME = "reel-places-db-v1";
const DB_VERSION = 1;
const STORE_NAMES = ["movies", "places", "logs"];
const METHODS = ["映画館", "配信", "Blu-ray / DVD", "TV", "機内", "その他"];
const STREAMING_SERVICES = ["Prime", "Netflix", "Disney+", "TVer", "その他"];
const CATEGORY_LABELS = { cinema: "映画館", travel: "旅行", food: "食事", other: "その他" };
const DEFAULT_CENTER = [36.5, 138];

const state = {
  db: null,
  movies: [],
  places: [],
  logs: [],
  activeView: "map",
  historyType: "all",
  libraryType: "movie",
  mainMap: null,
  mapLayer: null,
  pickerMaps: {},
  pickerMarkers: {},
  pickedLocations: { cinema: null, meal: null, place: null },
  imageData: { poster: null, meal: null },
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const byId = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
  try {
    state.db = await openDatabase();
    await refreshData();
    fillStaticOptions();
    bindEvents();
    setTodayDefaults();
    updateCinemaVisibility();
    updateRatingOutput();
    updateMealRatingOutput();
    initializeMainMap();
    renderAll();
  } catch (error) {
    console.error(error);
    showToast("保存機能を開始できませんでした。ブラウザの設定をご確認ください。", true);
  }
}

// ---------- IndexedDB（端末内のデータ保存） ----------

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      STORE_NAMES.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id" });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAll(storeName) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveItem(storeName, item) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(storeName, "readwrite").objectStore(storeName).put(item);
    request.onsuccess = () => resolve(item);
    request.onerror = () => reject(request.error);
  });
}

function deleteItem(storeName, id) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(storeName, "readwrite").objectStore(storeName).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearAllStores() {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(STORE_NAMES, "readwrite");
    STORE_NAMES.forEach((name) => transaction.objectStore(name).clear());
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function replaceAllData(data) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(STORE_NAMES, "readwrite");
    STORE_NAMES.forEach((name) => {
      const store = transaction.objectStore(name);
      store.clear();
      (data[name] || []).forEach((item) => store.put(item));
    });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function refreshData() {
  [state.movies, state.places, state.logs] = await Promise.all(STORE_NAMES.map(getAll));
}

// ---------- 初期化と共通イベント ----------

function fillStaticOptions() {
  const options = METHODS.map((method) => `<option value="${escapeHtml(method)}">${escapeHtml(method)}</option>`).join("");
  byId("movieMethod").innerHTML = options;
  byId("methodFilter").insertAdjacentHTML("beforeend", options);
  byId("streamingService").innerHTML = STREAMING_SERVICES.map((service) => `<option value="${escapeHtml(service)}">${escapeHtml(service)}</option>`).join("");
}

function bindEvents() {
  $$("[data-view-target]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewTarget)));
  $$(".go-add").forEach((button) => button.addEventListener("click", () => switchView("add")));
  $$(".go-add-meal").forEach((button) => button.addEventListener("click", () => { switchView("add"); setRecordType("meal"); }));
  byId("libraryTypeFilter").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    state.libraryType = button.dataset.value;
    $$("button", byId("libraryTypeFilter")).forEach((item) => item.classList.toggle("active", item === button));
    byId("movieLibrary").classList.toggle("hidden", state.libraryType !== "movie");
    byId("mealLibrary").classList.toggle("hidden", state.libraryType !== "meal");
    renderLibraryCount();
  });

  byId("recordType").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (button) setRecordType(button.dataset.value);
  });
  byId("historyTypeFilter").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    state.historyType = button.dataset.value;
    $$("button", byId("historyTypeFilter")).forEach((item) => item.classList.toggle("active", item === button));
    renderTimeline();
  });

  byId("movieMethod").addEventListener("change", updateCinemaVisibility);
  byId("existingCinema").addEventListener("change", updateNewCinemaVisibility);
  byId("movieRating").addEventListener("input", updateRatingOutput);
  byId("mealRating").addEventListener("input", updateMealRatingOutput);
  byId("movieForm").addEventListener("submit", saveMovieLog);
  byId("mealForm").addEventListener("submit", saveMealLog);
  byId("visitForm").addEventListener("submit", saveVisitLog);
  $$(".cancel-edit").forEach((button) => button.addEventListener("click", () => resetForm(button.dataset.form)));

  ["movieSearch", "yearFilter", "ratingFilter", "methodFilter", "cinemaFilter", "tagFilter"].forEach((id) => {
    byId(id).addEventListener(id === "movieSearch" || id === "tagFilter" ? "input" : "change", renderMovies);
  });
  byId("movieSearch").addEventListener("input", () => byId("clearSearch").classList.toggle("hidden", !byId("movieSearch").value));
  byId("clearSearch").addEventListener("click", () => { byId("movieSearch").value = ""; byId("clearSearch").classList.add("hidden"); renderMovies(); });
  byId("resetFilters").addEventListener("click", resetMovieFilters);
  $$(".map-filters input").forEach((input) => input.addEventListener("change", renderMapMarkers));

  byId("settingsButton").addEventListener("click", openSettings);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  [byId("detailDialog"), byId("settingsDialog")].forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }));
  byId("backupButton").addEventListener("click", downloadBackup);
  byId("restoreButton").addEventListener("click", () => byId("restoreInput").click());
  byId("restoreInput").addEventListener("change", restoreBackup);
  byId("clearDataButton").addEventListener("click", clearAllData);

  $$(".locate-button").forEach((button) => button.addEventListener("click", () => useCurrentLocation(button.dataset.target)));
  byId("placeName").addEventListener("change", loadExistingPlaceIntoVisitForm);
  byId("mealPlaceName").addEventListener("change", loadExistingPlaceIntoMealForm);
  byId("movieTitle").addEventListener("change", loadExistingMovieIntoForm);
  byId("moviePoster").addEventListener("change", (event) => handleImageSelection(event, "poster"));
  byId("mealPhoto").addEventListener("change", (event) => handleImageSelection(event, "meal"));
  $$(".remove-image").forEach((button) => button.addEventListener("click", () => setImageData(button.dataset.image, null)));
}

function setTodayDefaults() {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  byId("movieDate").value = today;
  byId("mealDate").value = today;
  byId("visitDate").value = today;
}

function switchView(viewName) {
  state.activeView = viewName;
  $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === viewName));
  $$("[data-view-target]").forEach((button) => button.classList.toggle("active", button.dataset.viewTarget === viewName));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (viewName === "map" && state.mainMap) setTimeout(() => state.mainMap.invalidateSize(), 80);
  if (viewName === "add") setTimeout(invalidateVisiblePicker, 80);
}

function setRecordType(type) {
  $$("button", byId("recordType")).forEach((button) => button.classList.toggle("active", button.dataset.value === type));
  byId("movieForm").classList.toggle("hidden", type !== "movie");
  byId("mealForm").classList.toggle("hidden", type !== "meal");
  byId("visitForm").classList.toggle("hidden", type !== "visit");
  setTimeout(() => initializePickerMap(type === "movie" ? "cinema" : type === "meal" ? "meal" : "place"), 50);
}

// ---------- 地図 ----------

function initializeMainMap() {
  if (!window.L) {
    byId("mainMap").innerHTML = '<div class="empty-state"><p>地図を読み込めませんでした。インターネット接続をご確認ください。</p></div>';
    return;
  }
  state.mainMap = L.map("mainMap", { zoomControl: true, attributionControl: true }).setView(DEFAULT_CENTER, 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.mainMap);
  state.mapLayer = L.layerGroup().addTo(state.mainMap);
  renderMapMarkers();
}

function renderMapMarkers() {
  if (!state.mainMap || !state.mapLayer) return;
  state.mapLayer.clearLayers();
  const activeCategories = new Set($$(".map-filters input:checked").map((input) => input.value));
  const visiblePlaces = state.places.filter((place) => activeCategories.has(place.category) && isCoordinate(place.lat, place.lng));
  visiblePlaces.forEach((place) => {
    const relatedLogs = state.logs.filter((log) => log.placeId === place.id).sort(sortByDateDesc);
    const markerSymbol = place.category === "cinema" ? "◉" : place.category === "food" ? "♨" : "•";
    const icon = L.divIcon({ className: "", html: `<div class="map-marker ${place.category}"><span>${markerSymbol}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -27] });
    const items = relatedLogs.slice(0, 5).map((log) => {
      const movie = getMovie(log.movieId);
      return `<li><strong>${escapeHtml(log.type === "movie" ? (movie?.title || "映画") : log.type === "meal" ? (log.title || "食事") : "訪問")}</strong> · ${formatDate(log.date)}</li>`;
    }).join("");
    const more = relatedLogs.length > 5 ? `<li>ほか ${relatedLogs.length - 5}件</li>` : "";
    L.marker([place.lat, place.lng], { icon }).bindPopup(`<h3 class="popup-title">${escapeHtml(place.name)}</h3><div class="popup-meta">${CATEGORY_LABELS[place.category] || "場所"} · ${relatedLogs.length}回の記録</div>${relatedLogs.length ? `<ul class="popup-list">${items}${more}</ul>` : ""}`).addTo(state.mapLayer);
  });
  byId("placeCount").textContent = `${visiblePlaces.length}か所`;
  byId("mapEmpty").classList.toggle("hidden", state.places.some((place) => isCoordinate(place.lat, place.lng)));
  if (visiblePlaces.length) {
    const bounds = L.latLngBounds(visiblePlaces.map((place) => [place.lat, place.lng]));
    if (bounds.isValid()) state.mainMap.fitBounds(bounds, { padding: [35, 35], maxZoom: 14 });
  }
}

function initializePickerMap(target) {
  if (!window.L || state.pickerMaps[target]) {
    state.pickerMaps[target]?.invalidateSize();
    return;
  }
  const elementId = target === "cinema" ? "cinemaPickerMap" : target === "meal" ? "mealPickerMap" : "placePickerMap";
  const map = L.map(elementId, { zoomControl: true }).setView(DEFAULT_CENTER, 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>' }).addTo(map);
  map.on("click", (event) => setPickedLocation(target, event.latlng.lat, event.latlng.lng, true));
  state.pickerMaps[target] = map;
}

function setPickedLocation(target, lat, lng, center = false) {
  initializePickerMap(target);
  if (!isCoordinate(lat, lng)) return;
  state.pickedLocations[target] = { lat: Number(lat), lng: Number(lng) };
  const map = state.pickerMaps[target];
  state.pickerMarkers[target]?.remove();
  state.pickerMarkers[target] = L.marker([lat, lng]).addTo(map);
  if (center) map.setView([lat, lng], Math.max(map.getZoom(), 15));
  const coordinateId = target === "cinema" ? "cinemaCoordinates" : target === "meal" ? "mealCoordinates" : "placeCoordinates";
  byId(coordinateId).textContent = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

function useCurrentLocation(target) {
  if (!navigator.geolocation) return showToast("この端末では現在地を利用できません", true);
  showToast("現在地を確認しています…");
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => { setPickedLocation(target, coords.latitude, coords.longitude, true); showToast("現在地を設定しました"); },
    () => showToast("現在地を取得できませんでした。地図をタップしてください。", true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function invalidateVisiblePicker() {
  const type = !byId("movieForm").classList.contains("hidden") ? "cinema" : !byId("mealForm").classList.contains("hidden") ? "meal" : "place";
  if (type === "cinema" && byId("cinemaFields").classList.contains("hidden")) return;
  initializePickerMap(type);
  state.pickerMaps[type]?.invalidateSize();
}

// ---------- 映画一覧・絞り込み ----------

function renderMovies() {
  const query = normalize(byId("movieSearch").value);
  const year = byId("yearFilter").value;
  const minRating = Number(byId("ratingFilter").value || 0);
  const method = byId("methodFilter").value;
  const cinemaId = byId("cinemaFilter").value;
  const tag = normalize(byId("tagFilter").value);

  const matchingLogs = state.logs.filter((log) => {
    if (log.type !== "movie") return false;
    const movie = getMovie(log.movieId);
    const text = normalize(`${movie?.title || ""} ${(log.tags || []).join(" ")}`);
    return (!query || text.includes(query)) && (!year || log.date?.startsWith(year)) && (!minRating || Number(log.rating) >= minRating) && (!method || log.method === method) && (!cinemaId || log.placeId === cinemaId) && (!tag || (log.tags || []).some((item) => normalize(item).includes(tag)));
  });

  const grouped = new Map();
  matchingLogs.sort(sortByDateDesc).forEach((log) => {
    if (!grouped.has(log.movieId)) grouped.set(log.movieId, []);
    grouped.get(log.movieId).push(log);
  });

  const cards = [...grouped.entries()].map(([movieId, logs]) => {
    const movie = getMovie(movieId);
    if (!movie) return "";
    const latest = logs[0];
    const allMovieLogs = state.logs.filter((log) => log.type === "movie" && log.movieId === movieId);
    const place = getPlace(latest.placeId);
    const tags = unique(allMovieLogs.flatMap((log) => log.tags || [])).slice(0, 3);
    const poster = movie.posterData ? `<img class="movie-poster-thumb" src="${movie.posterData}" alt="">` : '<span class="movie-poster-thumb movie-poster-placeholder">◉</span>';
    const methodLabel = latest.method === "配信" && latest.streamingService ? `${latest.method}・${latest.streamingService}` : latest.method;
    return `<button type="button" class="movie-card poster-card" data-movie-id="${movie.id}">${poster}<span class="movie-card-body"><strong class="movie-card-title">${escapeHtml(movie.title)}</strong><span class="movie-meta">${movie.releaseYear ? `<span>${movie.releaseYear}年公開</span>` : ""}<span>${formatDate(latest.date)}</span><span>${escapeHtml(methodLabel || "")}${place ? ` · ${escapeHtml(place.name)}` : ""}</span>${allMovieLogs.length > 1 ? `<span>${allMovieLogs.length}回鑑賞</span>` : ""}</span>${tags.length ? `<span class="tag-row">${tags.map(tagHtml).join("")}</span>` : ""}</span><span class="movie-rating">${ratingLabel(latest.rating)}<small>${latest.rating ? "RATING" : ""}</small></span></button>`;
  }).join("");

  byId("movieList").innerHTML = cards;
  const hasAnyMovies = state.logs.some((log) => log.type === "movie");
  byId("movieEmpty").classList.toggle("hidden", grouped.size > 0);
  if (hasAnyMovies && !grouped.size) byId("movieEmpty").innerHTML = '<span class="empty-icon">⌕</span><h3>一致する映画がありません</h3><p>検索語や絞り込み条件を変えてみてください。</p><button type="button" class="secondary-button" id="inlineResetFilters">条件をリセット</button>';
  else if (!hasAnyMovies) byId("movieEmpty").innerHTML = '<span class="empty-icon">◉</span><h3>まだ映画がありません</h3><p>観た映画を記録すると、作品ごとにここへまとまります。</p><button type="button" class="primary-button go-add">映画を記録する</button>';
  byId("inlineResetFilters")?.addEventListener("click", resetMovieFilters);
  $("#movieEmpty .go-add")?.addEventListener("click", () => switchView("add"));
  $$(".movie-card").forEach((card) => card.addEventListener("click", () => openMovieDetail(card.dataset.movieId)));

  const filterCount = [year, minRating, method, cinemaId, tag].filter(Boolean).length;
  byId("activeFilterCount").textContent = filterCount ? `(${filterCount})` : "";
  renderLibraryCount();
}

function renderMeals() {
  const logs = state.logs.filter((log) => log.type === "meal").sort(sortByDateDesc);
  byId("mealList").innerHTML = logs.map((log) => {
    const place = getPlace(log.placeId);
    const photo = log.photoData ? `<img class="meal-card-photo" src="${log.photoData}" alt="">` : '<span class="meal-card-photo meal-card-placeholder">♨</span>';
    return `<button type="button" class="movie-card meal-card" data-meal-log-id="${log.id}">${photo}<span class="movie-card-body"><strong class="movie-card-title">${escapeHtml(log.title || place?.name || "食事")}</strong><span class="movie-meta"><span>${formatDate(log.date)}</span>${log.title && place ? `<span>${escapeHtml(place.name)}</span>` : ""}</span>${log.tags?.length ? `<span class="tag-row">${log.tags.slice(0, 3).map(tagHtml).join("")}</span>` : ""}</span><span class="movie-rating">${ratingLabel(log.rating)}<small>${log.rating ? "RATING" : ""}</small></span></button>`;
  }).join("");
  byId("mealEmpty").classList.toggle("hidden", logs.length > 0);
  $$("[data-meal-log-id]").forEach((card) => card.addEventListener("click", () => openLogDetail(card.dataset.mealLogId)));
  renderLibraryCount();
}

function renderLibraryCount() {
  const count = state.libraryType === "meal" ? state.logs.filter((log) => log.type === "meal").length : new Set(state.logs.filter((log) => log.type === "movie").map((log) => log.movieId)).size;
  byId("movieCount").textContent = state.libraryType === "meal" ? `${count}件` : `${count}作品`;
}

function resetMovieFilters() {
  ["movieSearch", "yearFilter", "ratingFilter", "methodFilter", "cinemaFilter", "tagFilter"].forEach((id) => byId(id).value = "");
  byId("clearSearch").classList.add("hidden");
  renderMovies();
}

function renderFilterOptions() {
  const currentYear = byId("yearFilter").value;
  const years = unique(state.logs.map((log) => log.date?.slice(0, 4)).filter(Boolean)).sort().reverse();
  byId("yearFilter").innerHTML = '<option value="">すべて</option>' + years.map((year) => `<option value="${year}">${year}年</option>`).join("");
  byId("yearFilter").value = years.includes(currentYear) ? currentYear : "";

  const currentCinema = byId("cinemaFilter").value;
  const cinemas = state.places.filter((place) => place.category === "cinema").sort(sortByName);
  byId("cinemaFilter").innerHTML = '<option value="">すべて</option>' + cinemas.map((place) => `<option value="${place.id}">${escapeHtml(place.name)}</option>`).join("");
  byId("cinemaFilter").value = cinemas.some((place) => place.id === currentCinema) ? currentCinema : "";
}

// ---------- 履歴 ----------

function renderTimeline() {
  const logs = state.logs.filter((log) => state.historyType === "all" || log.type === state.historyType).sort(sortByDateDesc);
  byId("historyCount").textContent = `${logs.length}件`;
  byId("historyEmpty").classList.toggle("hidden", logs.length > 0);
  byId("timeline").innerHTML = logs.map((log) => {
    const movie = getMovie(log.movieId);
    const place = getPlace(log.placeId);
    const title = log.type === "movie" ? (movie?.title || "削除された映画") : log.type === "meal" ? (log.title || place?.name || "食事") : (place?.name || "削除された場所");
    const methodLabel = log.method === "配信" && log.streamingService ? `${log.method}・${log.streamingService}` : log.method;
    const sub = log.type === "movie" ? `${escapeHtml(methodLabel || "")}${place ? ` · ${escapeHtml(place.name)}` : ""}` : log.type === "meal" ? `食事${place ? ` · ${escapeHtml(place.name)}` : ""}` : `${CATEGORY_LABELS[place?.category] || "訪問"}`;
    const rating = (log.type === "movie" || log.type === "meal") && log.rating ? ` · <span class="stars">${ratingStars(log.rating)}</span> ${Number(log.rating).toFixed(1)}` : "";
    return `<div class="timeline-item"><span class="timeline-dot ${log.type}"></span><button type="button" class="timeline-card" data-log-id="${log.id}"><p class="timeline-date">${formatDate(log.date, true)}</p><h3>${escapeHtml(title)}</h3><div class="timeline-sub">${sub}${rating}</div></button></div>`;
  }).join("");
  $$(".timeline-card").forEach((card) => card.addEventListener("click", () => openLogDetail(card.dataset.logId)));
}

// ---------- 記録の追加・編集 ----------

function updateCinemaVisibility() {
  const visible = byId("movieMethod").value === "映画館";
  byId("cinemaFields").classList.toggle("hidden", !visible);
  byId("streamingFields").classList.toggle("hidden", byId("movieMethod").value !== "配信");
  if (visible) setTimeout(() => initializePickerMap("cinema"), 50);
}

function updateNewCinemaVisibility() {
  const isNew = !byId("existingCinema").value;
  byId("newCinemaFields").classList.toggle("hidden", !isNew);
  if (isNew) setTimeout(() => initializePickerMap("cinema"), 50);
}

function updateRatingOutput() {
  const value = Number(byId("movieRating").value);
  byId("ratingOutput").textContent = value ? value.toFixed(1) : "未評価";
}

function updateMealRatingOutput() {
  const value = Number(byId("mealRating").value);
  byId("mealRatingOutput").textContent = value ? value.toFixed(1) : "未評価";
}

async function saveMovieLog(event) {
  event.preventDefault();
  const title = byId("movieTitle").value.trim();
  const date = byId("movieDate").value;
  const method = byId("movieMethod").value;
  if (!title || !date) return showToast("タイトルと鑑賞日を入力してください", true);
  if (method === "映画館" && !byId("existingCinema").value && (!byId("cinemaName").value.trim() || !state.pickedLocations.cinema)) {
    return showToast("映画館名と地図上の位置を指定してください", true);
  }

  try {
    const now = new Date().toISOString();
    const editingLog = getLog(byId("movieLogId").value);
    let movie = getMovie(byId("movieId").value) || state.movies.find((item) => normalize(item.title) === normalize(title));
    if (!movie) movie = { id: makeId("movie"), createdAt: now };
    movie = {
      ...movie,
      title,
      releaseYear: byId("movieReleaseYear").value ? Number(byId("movieReleaseYear").value) : null,
      director: byId("movieDirector").value.trim(),
      starring: byId("movieStarring").value.trim(),
      posterData: state.imageData.poster,
      updatedAt: now,
    };
    await saveItem("movies", movie);

    let placeId = null;
    if (method === "映画館") {
      placeId = byId("existingCinema").value;
      if (!placeId) {
        const cinemaName = byId("cinemaName").value.trim();
        const location = state.pickedLocations.cinema;
        const existing = state.places.find((item) => item.category === "cinema" && normalize(item.name) === normalize(cinemaName));
        const place = existing || { id: makeId("place"), name: cinemaName, category: "cinema", ...location, createdAt: now };
        if (existing) Object.assign(place, { ...location, name: cinemaName, updatedAt: now });
        await saveItem("places", place);
        placeId = place.id;
      }
    }

    const log = {
      id: editingLog?.id || makeId("log"), type: "movie", movieId: movie.id, placeId,
      date, method, streamingService: method === "配信" ? byId("streamingService").value : null,
      rating: Number(byId("movieRating").value), notes: byId("movieNotes").value.trim(),
      tags: parseTags(byId("movieTags").value), createdAt: editingLog?.createdAt || now, updatedAt: now,
    };
    await saveItem("logs", log);
    await refreshData();
    await removeOrphans();
    await refreshData();
    resetForm("movie");
    renderAll();
    switchView("history");
    showToast(editingLog ? "映画の記録を更新しました" : "映画の記録を保存しました");
  } catch (error) {
    console.error(error); showToast("保存できませんでした", true);
  }
}

async function saveMealLog(event) {
  event.preventDefault();
  const placeName = byId("mealPlaceName").value.trim();
  const date = byId("mealDate").value;
  const location = state.pickedLocations.meal;
  if (!placeName || !date || !location) return showToast("店名・日付・地図上の位置を指定してください", true);

  try {
    const now = new Date().toISOString();
    const editingLog = getLog(byId("mealLogId").value);
    let place = getPlace(byId("mealPlaceId").value) || state.places.find((item) => item.category === "food" && normalize(item.name) === normalize(placeName));
    if (!place) place = { id: makeId("place"), createdAt: now };
    Object.assign(place, { name: placeName, category: "food", ...location, updatedAt: now });
    await saveItem("places", place);

    const log = {
      id: editingLog?.id || makeId("log"), type: "meal", placeId: place.id, movieId: null,
      title: byId("mealTitle").value.trim(), date, rating: Number(byId("mealRating").value),
      notes: byId("mealNotes").value.trim(), tags: parseTags(byId("mealTags").value),
      photoData: state.imageData.meal, createdAt: editingLog?.createdAt || now, updatedAt: now,
    };
    await saveItem("logs", log);
    await refreshData(); await removeOrphans(); await refreshData();
    resetForm("meal"); renderAll(); switchView("history");
    showToast(editingLog ? "食事の記録を更新しました" : "食事の記録を保存しました");
  } catch (error) {
    console.error(error); showToast("保存できませんでした", true);
  }
}

async function saveVisitLog(event) {
  event.preventDefault();
  const name = byId("placeName").value.trim();
  const date = byId("visitDate").value;
  const location = state.pickedLocations.place;
  if (!name || !date || !location) return showToast("場所名・日付・地図上の位置を指定してください", true);

  try {
    const now = new Date().toISOString();
    const editingLog = getLog(byId("visitLogId").value);
    let place = getPlace(byId("visitPlaceId").value) || state.places.find((item) => normalize(item.name) === normalize(name));
    if (!place) place = { id: makeId("place"), createdAt: now };
    Object.assign(place, { name, category: byId("placeCategory").value, ...location, updatedAt: now });
    await saveItem("places", place);
    const log = {
      id: editingLog?.id || makeId("log"), type: "visit", placeId: place.id, movieId: null,
      date, method: null, rating: 0, notes: byId("visitNotes").value.trim(), tags: parseTags(byId("visitTags").value),
      createdAt: editingLog?.createdAt || now, updatedAt: now,
    };
    await saveItem("logs", log);
    await refreshData();
    await removeOrphans();
    await refreshData();
    resetForm("visit");
    renderAll();
    switchView("history");
    showToast(editingLog ? "訪問の記録を更新しました" : "訪問の記録を保存しました");
  } catch (error) {
    console.error(error); showToast("保存できませんでした", true);
  }
}

function editLog(logId) {
  const log = getLog(logId);
  if (!log) return;
  byId("detailDialog").close();
  switchView("add");
  setRecordType(log.type);
  if (log.type === "movie") {
    const movie = getMovie(log.movieId);
    byId("movieLogId").value = log.id; byId("movieId").value = log.movieId;
    byId("movieTitle").value = movie?.title || ""; byId("movieDate").value = log.date;
    byId("movieMethod").value = log.method; byId("movieRating").value = log.rating || 0;
    byId("streamingService").value = log.streamingService || STREAMING_SERVICES[0];
    byId("movieReleaseYear").value = movie?.releaseYear || "";
    byId("movieDirector").value = movie?.director || "";
    byId("movieStarring").value = movie?.starring || "";
    setImageData("poster", movie?.posterData || null);
    byId("movieNotes").value = log.notes || ""; byId("movieTags").value = (log.tags || []).join(", ");
    byId("existingCinema").value = log.placeId || "";
    byId("movieSubmitText").textContent = "映画の記録を更新";
    $('[data-form="movie"]').classList.remove("hidden");
    updateRatingOutput(); updateCinemaVisibility(); updateNewCinemaVisibility();
  } else if (log.type === "meal") {
    const place = getPlace(log.placeId);
    byId("mealLogId").value = log.id; byId("mealPlaceId").value = log.placeId;
    byId("mealPlaceName").value = place?.name || ""; byId("mealTitle").value = log.title || "";
    byId("mealDate").value = log.date; byId("mealRating").value = log.rating || 0;
    byId("mealNotes").value = log.notes || ""; byId("mealTags").value = (log.tags || []).join(", ");
    byId("mealSubmitText").textContent = "食事の記録を更新";
    $('[data-form="meal"]').classList.remove("hidden");
    setImageData("meal", log.photoData || null); updateMealRatingOutput();
    if (place) setTimeout(() => setPickedLocation("meal", place.lat, place.lng, true), 100);
  } else {
    const place = getPlace(log.placeId);
    byId("visitLogId").value = log.id; byId("visitPlaceId").value = log.placeId;
    byId("placeName").value = place?.name || ""; byId("visitDate").value = log.date;
    byId("placeCategory").value = place?.category || "other"; byId("visitNotes").value = log.notes || "";
    byId("visitTags").value = (log.tags || []).join(", ");
    byId("visitSubmitText").textContent = "訪問の記録を更新";
    $('[data-form="visit"]').classList.remove("hidden");
    if (place) setTimeout(() => setPickedLocation("place", place.lat, place.lng, true), 100);
  }
}

function resetForm(type) {
  const form = byId(type === "movie" ? "movieForm" : type === "meal" ? "mealForm" : "visitForm");
  form.reset();
  setTodayDefaults();
  if (type === "movie") {
    byId("movieLogId").value = ""; byId("movieId").value = ""; byId("movieRating").value = 0;
    byId("movieSubmitText").textContent = "映画の記録を保存"; $('[data-form="movie"]').classList.add("hidden");
    updateRatingOutput(); updateCinemaVisibility(); updateNewCinemaVisibility(); clearPicker("cinema");
    setImageData("poster", null);
  } else if (type === "meal") {
    byId("mealLogId").value = ""; byId("mealPlaceId").value = ""; byId("mealRating").value = 0;
    byId("mealSubmitText").textContent = "食事の記録を保存"; $('[data-form="meal"]').classList.add("hidden");
    updateMealRatingOutput(); clearPicker("meal"); setImageData("meal", null);
  } else {
    byId("visitLogId").value = ""; byId("visitPlaceId").value = "";
    byId("visitSubmitText").textContent = "訪問の記録を保存"; $('[data-form="visit"]').classList.add("hidden"); clearPicker("place");
  }
}

function clearPicker(target) {
  state.pickedLocations[target] = null;
  state.pickerMarkers[target]?.remove(); state.pickerMarkers[target] = null;
  const coordinate = byId(target === "cinema" ? "cinemaCoordinates" : target === "meal" ? "mealCoordinates" : "placeCoordinates");
  if (coordinate) coordinate.textContent = "地図をタップして指定";
}

function loadExistingPlaceIntoVisitForm() {
  const place = state.places.find((item) => normalize(item.name) === normalize(byId("placeName").value));
  byId("visitPlaceId").value = place?.id || "";
  if (place) {
    byId("placeCategory").value = place.category;
    setPickedLocation("place", place.lat, place.lng, true);
    showToast("登録済みの場所を選びました");
  }
}

function loadExistingPlaceIntoMealForm() {
  const place = state.places.find((item) => item.category === "food" && normalize(item.name) === normalize(byId("mealPlaceName").value));
  byId("mealPlaceId").value = place?.id || "";
  if (place) {
    setPickedLocation("meal", place.lat, place.lng, true);
    showToast("登録済みのお店を選びました");
  }
}

function loadExistingMovieIntoForm() {
  const movie = state.movies.find((item) => normalize(item.title) === normalize(byId("movieTitle").value));
  byId("movieId").value = movie?.id || "";
  if (!movie) return;
  byId("movieReleaseYear").value = movie.releaseYear || "";
  byId("movieDirector").value = movie.director || "";
  byId("movieStarring").value = movie.starring || "";
  setImageData("poster", movie.posterData || null);
  showToast("登録済みの作品情報を読み込みました");
}

async function handleImageSelection(event, target) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) return showToast("画像ファイルを選んでください", true);
  try {
    showToast("画像を読み込んでいます…");
    const dataUrl = await compressImage(file, target === "poster" ? 1200 : 1600, 0.82);
    setImageData(target, dataUrl);
    showToast("画像を追加しました");
  } catch (error) {
    console.error(error); showToast("画像を読み込めませんでした", true);
  }
}

function compressImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setImageData(target, dataUrl) {
  state.imageData[target] = dataUrl;
  const preview = byId(target === "poster" ? "moviePosterPreview" : "mealPhotoPreview");
  preview.innerHTML = dataUrl ? `<img src="${dataUrl}" alt="選択した画像のプレビュー">` : "+";
  $(`[data-image="${target}"]`).classList.toggle("hidden", !dataUrl);
}

// ---------- 詳細・削除 ----------

function openMovieDetail(movieId) {
  const movie = getMovie(movieId);
  const logs = state.logs.filter((log) => log.type === "movie" && log.movieId === movieId).sort(sortByDateDesc);
  if (!movie || !logs.length) return;
  const credits = [movie.releaseYear ? `${movie.releaseYear}年公開` : "", movie.director ? `監督：${movie.director}` : "", movie.starring ? `主演：${movie.starring}` : ""].filter(Boolean);
  byId("detailContent").innerHTML = `<div class="detail-type">FILM · ${logs.length > 1 ? `${logs.length} WATCHES` : "WATCHED"}</div><h2 class="detail-title">${escapeHtml(movie.title)}</h2><p class="detail-date">最新の鑑賞 ${formatDate(logs[0].date, true)}</p>${movie.posterData ? `<img class="detail-image detail-poster" src="${movie.posterData}" alt="${escapeHtml(movie.title)}のポスター">` : ""}${credits.length ? `<div class="detail-grid">${credits.map((item) => `<div class="detail-cell"><strong>${escapeHtml(item)}</strong></div>`).join("")}</div>` : ""}<ul class="watch-list">${logs.map((log) => { const place = getPlace(log.placeId); const method = log.method === "配信" && log.streamingService ? `${log.method}・${log.streamingService}` : log.method; return `<li><button type="button" data-detail-log="${log.id}"><strong>${formatDate(log.date)} · ${ratingLabel(log.rating)}</strong><span>${escapeHtml(method || "")}${place ? ` · ${escapeHtml(place.name)}` : ""}${log.notes ? ` · ${escapeHtml(shorten(log.notes, 35))}` : ""}</span></button></li>`; }).join("")}</ul>`;
  $$('[data-detail-log]', byId("detailContent")).forEach((button) => button.addEventListener("click", () => openLogDetail(button.dataset.detailLog)));
  showDialog(byId("detailDialog"));
}

function openLogDetail(logId) {
  const log = getLog(logId);
  if (!log) return;
  const movie = getMovie(log.movieId);
  const place = getPlace(log.placeId);
  const isMovie = log.type === "movie";
  const isMeal = log.type === "meal";
  const title = isMovie ? movie?.title : isMeal ? (log.title || place?.name) : place?.name;
  const method = log.method === "配信" && log.streamingService ? `${log.method}・${log.streamingService}` : log.method;
  const cells = isMovie ? `<div class="detail-cell"><small>鑑賞方法</small><strong>${escapeHtml(method || "—")}</strong></div><div class="detail-cell"><small>映画館</small><strong>${escapeHtml(place?.name || "—")}</strong></div>${movie?.releaseYear ? `<div class="detail-cell"><small>公開年</small><strong>${movie.releaseYear}年</strong></div>` : ""}${movie?.director ? `<div class="detail-cell"><small>監督</small><strong>${escapeHtml(movie.director)}</strong></div>` : ""}${movie?.starring ? `<div class="detail-cell"><small>主演</small><strong>${escapeHtml(movie.starring)}</strong></div>` : ""}` : isMeal ? `<div class="detail-cell"><small>店名</small><strong>${escapeHtml(place?.name || "—")}</strong></div><div class="detail-cell"><small>料理</small><strong>${escapeHtml(log.title || "—")}</strong></div>` : `<div class="detail-cell"><small>カテゴリ</small><strong>${CATEGORY_LABELS[place?.category] || "その他"}</strong></div><div class="detail-cell"><small>場所</small><strong>${escapeHtml(place?.name || "—")}</strong></div>`;
  const image = isMeal && log.photoData ? `<img class="detail-image" src="${log.photoData}" alt="食事の写真">` : isMovie && movie?.posterData ? `<img class="detail-image detail-poster" src="${movie.posterData}" alt="映画のポスター">` : "";
  byId("detailContent").innerHTML = `<div class="detail-type">${isMovie ? "FILM LOG" : isMeal ? "MEAL LOG" : "PLACE LOG"}</div><h2 class="detail-title">${escapeHtml(title || "記録")}</h2><p class="detail-date">${formatDate(log.date, true)}</p>${(isMovie || isMeal) && log.rating ? `<div class="detail-rating">${ratingStars(log.rating)} <small>${Number(log.rating).toFixed(1)}</small></div>` : ""}${image}<div class="detail-grid">${cells}</div>${log.notes ? `<div class="detail-notes">${escapeHtml(log.notes)}</div>` : '<div class="detail-notes">感想・メモはありません。</div>'}${log.tags?.length ? `<div class="tag-row">${log.tags.map(tagHtml).join("")}</div>` : ""}<div class="detail-actions"><button type="button" class="secondary-button" id="editLogButton">編集する</button><button type="button" class="danger-button" id="deleteLogButton">削除する</button></div>`;
  byId("editLogButton").addEventListener("click", () => editLog(log.id));
  byId("deleteLogButton").addEventListener("click", () => confirmDeleteLog(log.id));
  showDialog(byId("detailDialog"));
}

async function confirmDeleteLog(logId) {
  const log = getLog(logId);
  if (!log || !confirm("この記録を削除しますか？\nこの操作は元に戻せません。")) return;
  await deleteItem("logs", log.id);
  await refreshData();
  await removeOrphans();
  await refreshData();
  byId("detailDialog").close();
  renderAll();
  showToast("記録を削除しました");
}

async function removeOrphans() {
  const usedMovieIds = new Set(state.logs.filter((log) => log.type === "movie").map((log) => log.movieId));
  const usedPlaceIds = new Set(state.logs.map((log) => log.placeId).filter(Boolean));
  await Promise.all([
    ...state.movies.filter((movie) => !usedMovieIds.has(movie.id)).map((movie) => deleteItem("movies", movie.id)),
    ...state.places.filter((place) => !usedPlaceIds.has(place.id)).map((place) => deleteItem("places", place.id)),
  ]);
}

// ---------- バックアップと復元 ----------

function openSettings() {
  const movieLogs = state.logs.filter((log) => log.type === "movie").length;
  const mealLogs = state.logs.filter((log) => log.type === "meal").length;
  const visitLogs = state.logs.filter((log) => log.type === "visit").length;
  byId("dataSummary").innerHTML = `<div class="summary-item"><strong>${state.movies.length}</strong><span>作品</span></div><div class="summary-item"><strong>${movieLogs}</strong><span>鑑賞</span></div><div class="summary-item"><strong>${mealLogs}</strong><span>食事</span></div><div class="summary-item"><strong>${visitLogs}</strong><span>訪問</span></div>`;
  showDialog(byId("settingsDialog"));
}

function downloadBackup() {
  const backup = { app: "Reel & Places", formatVersion: 1, exportedAt: new Date().toISOString(), movies: state.movies, places: state.places, logs: state.logs };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).replaceAll("-", "");
  link.href = url; link.download = `reel-places-backup-${date}.reelplaces`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("バックアップを保存しました");
}

async function restoreBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    validateBackup(data);
    if (!confirm(`バックアップの内容で現在のデータを置き換えます。\n\n作品 ${data.movies.length}件 / 場所 ${data.places.length}件 / 履歴 ${data.logs.length}件\n\n続けますか？`)) return;
    await replaceAllData(data);
    await refreshData();
    resetForm("movie"); resetForm("meal"); resetForm("visit"); renderAll();
    byId("settingsDialog").close(); showToast("バックアップを復元しました");
  } catch (error) {
    console.error(error); showToast("このファイルは復元に使用できません", true);
  }
}

function validateBackup(data) {
  if (!data || data.formatVersion !== 1 || !Array.isArray(data.movies) || !Array.isArray(data.places) || !Array.isArray(data.logs)) throw new Error("Invalid backup");
  [...data.movies, ...data.places, ...data.logs].forEach((item) => { if (!item || typeof item.id !== "string") throw new Error("Invalid record"); });
  [...data.movies.map((item) => item.posterData), ...data.logs.map((item) => item.photoData)].filter(Boolean).forEach((image) => {
    if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/i.test(image)) throw new Error("Invalid image");
  });
}

async function clearAllData() {
  if (!confirm("映画・場所・履歴をすべて削除しますか？\n先にバックアップを保存することをおすすめします。")) return;
  if (!confirm("本当にすべて削除しますか？この操作は元に戻せません。")) return;
  await clearAllStores(); await refreshData(); renderAll();
  byId("settingsDialog").close(); showToast("すべてのデータを削除しました");
}

// ---------- 全画面の再描画 ----------

function renderAll() {
  renderDynamicOptions();
  renderFilterOptions();
  renderMovies();
  renderMeals();
  renderTimeline();
  renderMapMarkers();
}

function renderDynamicOptions() {
  const cinemas = state.places.filter((place) => place.category === "cinema").sort(sortByName);
  const selectedCinema = byId("existingCinema").value;
  byId("existingCinema").innerHTML = '<option value="">新しい映画館を登録</option>' + cinemas.map((place) => `<option value="${place.id}">${escapeHtml(place.name)}</option>`).join("");
  if (cinemas.some((place) => place.id === selectedCinema)) byId("existingCinema").value = selectedCinema;
  byId("movieTitles").innerHTML = state.movies.sort(sortByName).map((movie) => `<option value="${escapeHtml(movie.title)}"></option>`).join("");
  byId("placeNames").innerHTML = state.places.sort(sortByName).map((place) => `<option value="${escapeHtml(place.name)}"></option>`).join("");
  byId("foodPlaceNames").innerHTML = state.places.filter((place) => place.category === "food").sort(sortByName).map((place) => `<option value="${escapeHtml(place.name)}"></option>`).join("");
}

// ---------- 小さな共通処理 ----------

function getMovie(id) { return state.movies.find((item) => item.id === id); }
function getPlace(id) { return state.places.find((item) => item.id === id); }
function getLog(id) { return state.logs.find((item) => item.id === id); }
function makeId(prefix) { return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`}`; }
function sortByDateDesc(a, b) { return String(b.date || "").localeCompare(String(a.date || "")) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")); }
function sortByName(a, b) { return String(a.name || a.title || "").localeCompare(String(b.name || b.title || ""), "ja"); }
function normalize(value) { return String(value || "").trim().toLocaleLowerCase("ja").normalize("NFKC"); }
function unique(values) { return [...new Set(values)]; }
function parseTags(value) { return unique(String(value || "").split(/[、,]/).map((tag) => tag.trim()).filter(Boolean)); }
function shorten(value, length) { return value.length > length ? `${value.slice(0, length)}…` : value; }
function isCoordinate(lat, lng) { return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)); }
function formatDate(value, withWeekday = false) {
  if (!value) return "日付なし";
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", ...(withWeekday ? { weekday: "short" } : {}) }).format(date);
}
function ratingLabel(value) { return Number(value) ? Number(value).toFixed(1) : "—"; }
function ratingStars(value) {
  const rounded = Math.round(Number(value));
  return "★".repeat(rounded) + "☆".repeat(5 - rounded);
}
function tagHtml(tag) { return `<span class="tag">#${escapeHtml(tag)}</span>`; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}
function showDialog(dialog) { if (dialog.open) dialog.close(); dialog.showModal(); }
function showToast(message, isError = false) {
  const toast = byId("toast"); clearTimeout(state.toastTimer);
  toast.textContent = message; toast.style.background = isError ? "#8f2f20" : "#242424"; toast.classList.add("show");
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), isError ? 4200 : 2600);
}
