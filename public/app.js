const form = document.querySelector("#filtersForm");
const brandSelect = document.querySelector("#brand");
const discountInput = document.querySelector("#discount");
const discountValue = document.querySelector("#discountValue");
const dealGrid = document.querySelector("#dealGrid");
const notice = document.querySelector("#notice");
const statusLabel = document.querySelector("#connectionStatus");
const dealCount = document.querySelector("#dealCount");
const listingCount = document.querySelector("#listingCount");
const lastScan = document.querySelector("#lastScan");
const template = document.querySelector("#dealTemplate");

const currency = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
  maximumFractionDigits: 0
});

const number = new Intl.NumberFormat("pl-PL");

init();

async function init() {
  discountInput.addEventListener("input", () => {
    discountValue.textContent = `${discountInput.value}%`;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runScan();
  });

  await loadBrands();
  await runScan();
}

async function loadBrands() {
  try {
    const response = await fetch("/api/brands");
    const data = await response.json();
    for (const brand of data.brands || []) {
      const option = document.createElement("option");
      option.value = brand;
      option.textContent = brand;
      brandSelect.append(option);
    }
  } catch {
    setNotice("Nie udało się pobrać listy marek.", "warn");
  }
}

async function runScan() {
  const submit = form.querySelector("button[type='submit']");
  submit.disabled = true;
  setStatus("Skanuję", true);
  setNotice("Pobieram najnowsze ogłoszenia z OLX...");
  renderSkeletons();

  try {
    const response = await fetch(`/api/deals?${buildQuery()}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.details || data.error || "Błąd pobierania");
    }
    renderResults(data);
    setStatus("Gotowy");
  } catch (error) {
    dealGrid.innerHTML = "";
    dealCount.textContent = "0";
    listingCount.textContent = "0";
    setNotice(error.message || "Nie udało się wykonać analizy.", "warn");
    setStatus("Błąd");
  } finally {
    submit.disabled = false;
  }
}

function buildQuery() {
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) {
    if (key === "fresh") continue;
    if (String(value).trim()) params.set(key, String(value).trim());
  }
  params.set("fresh", document.querySelector("#fresh").checked ? "true" : "false");
  params.set("pages", "3");
  return params;
}

function renderResults(data) {
  dealCount.textContent = number.format(data.dealCount || 0);
  listingCount.textContent = number.format(data.totalListings || 0);
  lastScan.textContent = new Date(data.fetchedAt).toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const warnings = data.warnings || [];
  if (warnings.length) {
    setNotice(warnings[0], "warn");
  } else {
    setNotice(`Znaleziono ${data.dealCount} okazji poniżej ustawionego progu.`);
  }

  const results = data.deals?.length ? data.deals : data.listings || [];
  dealGrid.innerHTML = "";
  for (const listing of results.slice(0, 30)) {
    dealGrid.append(renderCard(listing));
  }

  if (!results.length) {
    dealGrid.innerHTML = "";
  }
}

function renderCard(listing) {
  const node = template.content.firstElementChild.cloneNode(true);
  const imageLink = node.querySelector(".image-link");
  const image = node.querySelector("img");
  const title = node.querySelector("h2");
  const discount = node.querySelector(".discount");
  const price = node.querySelector(".price");
  const market = node.querySelector(".market");
  const year = node.querySelector(".year");
  const mileage = node.querySelector(".mileage");
  const comparable = node.querySelector(".comparable");
  const meta = node.querySelector(".meta");
  const flags = node.querySelector(".flags");
  const score = node.querySelector(".score-badge");
  const link = node.querySelector(".open-link");

  title.textContent = listing.title;
  discount.textContent = listing.discountPct > 0 ? `-${listing.discountPct}%` : "rynkowo";
  price.textContent = currency.format(listing.price);
  market.textContent = listing.marketPrice
    ? `Rynek: ${currency.format(listing.marketPrice)} · ${listing.confidence}`
    : "Za mało danych rynkowych";
  year.textContent = listing.year || "brak";
  mileage.textContent = listing.mileage ? `${number.format(listing.mileage)} km` : "brak";
  comparable.textContent = listing.comparableLabel || `${listing.comparableCount || 0} ogł.`;
  meta.textContent = [listing.location, listing.dateText].filter(Boolean).join(" · ");
  score.textContent = `${listing.score || 0} pkt`;

  image.alt = listing.title;
  image.src = listing.image || "";
  imageLink.href = listing.url;
  link.href = listing.url;

  const comparableFlag = document.createElement("span");
  comparableFlag.className = "flag";
  comparableFlag.textContent = `${listing.comparableCount || 0} porównań`;
  flags.append(comparableFlag);

  for (const flag of listing.riskFlags || []) {
    const item = document.createElement("span");
    item.className = "flag risk";
    item.textContent = flag;
    flags.append(item);
  }

  return node;
}

function renderSkeletons() {
  dealGrid.innerHTML = "";
  for (let index = 0; index < 6; index += 1) {
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton";
    dealGrid.append(skeleton);
  }
}

function setNotice(message, tone = "") {
  notice.textContent = message;
  if (tone) {
    notice.dataset.tone = tone;
  } else {
    delete notice.dataset.tone;
  }
}

function setStatus(message, busy = false) {
  statusLabel.lastChild.textContent = ` ${message}`;
  statusLabel.querySelector(".pulse").style.background = busy ? "#c98612" : message === "Błąd" ? "#b8453f" : "#238052";
}
