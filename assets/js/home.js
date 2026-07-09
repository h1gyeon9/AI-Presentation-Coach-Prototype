// Home mode selection
const modeCards = [...document.querySelectorAll(".mode-card")];
const nextButton = document.getElementById("home-next");
let selectedMode = "presentation";

modeCards.forEach((card) => {
  card.addEventListener("click", () => {
    selectedMode = card.dataset.mode;
    modeCards.forEach((item) => {
      const selected = item === card;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
  });
});

nextButton.addEventListener("click", () => {
  window.location.href = selectedMode === "interview" ? "./interview.html" : "./presentation.html";
});
