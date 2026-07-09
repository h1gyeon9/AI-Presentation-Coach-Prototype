// Home mode selection
const modeCards = [...document.querySelectorAll(".mode-card")];
const nextButton = document.getElementById("home-next");
let selectedMode = null;

modeCards.forEach((card) => {
  card.addEventListener("click", () => {
    selectedMode = card.dataset.mode;
    modeCards.forEach((item) => {
      const selected = item === card;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    nextButton.disabled = false;
  });
});

nextButton.addEventListener("click", () => {
  if (!selectedMode) return;
  window.location.href = selectedMode === "interview" ? "./interview.html" : "./presentation.html";
});
