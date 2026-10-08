// Progressive enhancement for every form posting to /api/form: submit with fetch, show the result
// inline, attach saved network-test results, and preselect `need` from the query string.
(function () {
  var TEST_KEY = "howdynet.test";

  function readTest() {
    try { return JSON.parse(sessionStorage.getItem(TEST_KEY) || "null"); } catch (e) { return null; }
  }

  function attachTest(form) {
    var t = readTest();
    if (!t) return;
    Object.keys(t).forEach(function (k) {
      var v = t[k];
      if (v == null || v === "") return;
      var input = form.querySelector('input[name="' + k + '"]');
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden";
        input.name = k;
        form.appendChild(input);
      }
      input.value = String(v);
    });
    var note = form.querySelector("[data-test-note]");
    if (note && t["quality-score"]) {
      note.textContent = "Your network test (score " + t["quality-score"] + "/100) will be attached.";
      note.hidden = false;
    }
  }

  function preselect(form) {
    var need = new URLSearchParams(location.search).get("need");
    if (!need) return;
    var radio = form.querySelector('input[name="need"][value="' + need + '"]');
    if (radio) radio.checked = true;
    var select = form.querySelector('select[name="need"]');
    if (select) select.value = need;
  }

  function show(el, msg) {
    if (!el) return;
    if (msg) el.textContent = msg;
    el.classList.add("show");
  }
  function hide(el) { if (el) el.classList.remove("show"); }

  function wire(form) {
    attachTest(form);
    preselect(form);
    var err = form.querySelector(".form-error");
    var ok = form.querySelector(".form-ok");
    if (new URLSearchParams(location.search).get("sent") === "1") {
      show(ok, "Thanks. We got it and a person will reply the same business day.");
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      hide(err); hide(ok);
      var btn = form.querySelector('[type="submit"]');
      var label = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "Sending"; }
      fetch(form.action, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (res) {
          if (res.ok) {
            form.reset();
            try { sessionStorage.removeItem(TEST_KEY); } catch (e) {}
            show(ok, "Thanks. We got it and a person will reply the same business day.");
            ok && ok.scrollIntoView({ block: "nearest" });
          } else {
            show(err, res.error || "Something went wrong. Call or email us instead.");
          }
        })
        .catch(function () { show(err, "Could not reach the server. Call or email us instead."); })
        .then(function () {
          if (btn) { btn.disabled = false; btn.textContent = label; }
          if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
        });
    });
  }

  window.howdyForms = { readTest: readTest, TEST_KEY: TEST_KEY };
  document.querySelectorAll('form[action="/api/form"]').forEach(wire);
})();
