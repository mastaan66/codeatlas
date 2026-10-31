// SnapStudy frontend — vanilla JS, no build step.
(() => {
  const $ = (id) => document.getElementById(id);

  const stages = {
    upload: $('stage-upload'),
    loading: $('stage-loading'),
    results: $('stage-results'),
    error: $('stage-error'),
  };

  const i18n = {
    en: {
      summary: 'Summary',
      flashcards: 'Flashcards',
      quiz: 'Quiz',
      fliphint: 'Tap a card to flip it',
      front: 'Question',
      back: 'Answer',
      scoreTitle: (s, t) => `You scored ${s} / ${t} ${s === t ? '🏆' : s >= t / 2 ? '🎉' : '💪'}`,
      scoreSub: 'Flip through the flashcards again and retry!',
      retake: 'Retake quiz',
      loadingMsgs: [
        'Reading your notes…',
        'Understanding the concepts…',
        'Writing a clean summary…',
        'Crafting flashcards…',
        'Building your quiz…',
        'Almost there — polishing…',
      ],
    },
    te: {
      summary: 'సారాంశం',
      flashcards: 'ఫ్లాష్‌కార్డులు',
      quiz: 'క్విజ్',
      fliphint: 'కార్డును తిప్పడానికి నొక్కండి',
      front: 'ప్రశ్న',
      back: 'జవాబు',
      scoreTitle: (s, t) => `మీ స్కోరు ${s} / ${t} ${s === t ? '🏆' : s >= t / 2 ? '🎉' : '💪'}`,
      scoreSub: 'ఫ్లాష్‌కార్డులను మళ్లీ చదివి మళ్ళీ ప్రయత్నించండి!',
      retake: 'క్విజ్ మళ్లీ రాయండి',
      loadingMsgs: [
        'మీ నోట్సు చదువుతోంది…',
        'భావనలను అర్థం చేసుకుంటోంది…',
        'సారాంశం రాస్తోంది…',
        'ఫ్లాష్‌కార్డులు తయారుచేస్తోంది…',
        'క్విజ్ సిద్ధం చేస్తోంది…',
        'దాదాపు పూర్తయింది…',
      ],
    },
  };

  let state = {
    file: null,
    previewUrl: null,
    language: 'en',
    data: null,
    quizAnswers: [],
    loadingTimer: null,
    progressTimer: null,
  };

  function show(stageName) {
    Object.entries(stages).forEach(([name, el]) => el.classList.toggle('hidden', name !== stageName));
  }

  function t(key) {
    return i18n[state.language][key];
  }

  function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = i18n[state.language][el.dataset.i18n];
      if (typeof v === 'string') el.textContent = v;
    });
  }

  // ---------- upload ----------
  const dropzone = $('dropzone');
  const fileInput = $('file-input');
  const cameraInput = $('camera-input');

  function acceptFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    state.file = file;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(file);
    $('preview-img').src = state.previewUrl;
    $('preview-wrap').classList.remove('hidden');
    dropzone.classList.add('hidden');
  }

  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('label')) return; // let the label open its own picker
    fileInput.click();
  });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    acceptFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => acceptFile(fileInput.files[0]));
  cameraInput.addEventListener('change', () => acceptFile(cameraInput.files[0]));

  $('clear-btn').addEventListener('click', resetToUpload);
  $('new-photo-btn').addEventListener('click', resetToUpload);
  $('retry-btn').addEventListener('click', () => {
    if (state.file) generate(); else resetToUpload();
  });

  function resetToUpload() {
    state.file = null;
    state.data = null;
    fileInput.value = '';
    cameraInput.value = '';
    $('preview-wrap').classList.add('hidden');
    dropzone.classList.remove('hidden');
    show('upload');
  }

  // ---------- theme toggle ----------
  $('theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    let current = root.getAttribute('data-theme');
    if (current !== 'light' && current !== 'dark') {
      current = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    const next = current === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('snapstudy-theme', next); } catch (e) {}
  });

  // ---------- language toggle ----------
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang === state.language) return;
      state.language = btn.dataset.lang;
      document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('active', b === btn));
      applyStaticI18n();
      // Re-run generation in the new language if we already have an image processed/being viewed.
      if (state.file && (state.data || !stages.results.classList.contains('hidden'))) generate();
    });
  });

  // ---------- generation ----------
  $('generate-btn').addEventListener('click', generate);

  function startLoadingFx() {
    const msgs = t('loadingMsgs');
    let i = 0;
    $('loading-msg').textContent = msgs[0];
    state.loadingTimer = setInterval(() => {
      i = (i + 1) % msgs.length;
      $('loading-msg').textContent = msgs[i];
    }, 7000);
    let pct = 0;
    $('progress-bar').style.width = '0%';
    state.progressTimer = setInterval(() => {
      // asymptotic fake progress: never reaches 100 until done
      pct += (92 - pct) * 0.06;
      $('progress-bar').style.width = pct.toFixed(1) + '%';
    }, 800);
  }

  function stopLoadingFx() {
    clearInterval(state.loadingTimer);
    clearInterval(state.progressTimer);
    $('progress-bar').style.width = '100%';
  }

  async function generate() {
    if (!state.file) return;
    show('loading');
    startLoadingFx();

    const form = new FormData();
    form.append('image', state.file);
    form.append('language', state.language);
    form.append('mode', 'all');

    try {
      const res = await fetch('/api/study', {
        method: 'POST',
        body: form,
        // Don't hang forever: hosted generation finishes well within 2 minutes.
        signal: AbortSignal.timeout(120000),
      });
      const data = await res.json().catch(() => null);
      stopLoadingFx();
      if (!res.ok || !data || data.error) {
        throw new Error((data && (data.error + ' ' + JSON.stringify(data.detail || ''))) || `HTTP ${res.status}`);
      }
      state.data = data;
      renderResults();
      show('results');
    } catch (err) {
      stopLoadingFx();
      let msg;
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        msg = 'The request timed out after 2 minutes. The model may be overloaded — press “Try again”.';
      } else if (err instanceof TypeError) {
        // fetch() rejects with TypeError only on network-level failures
        // (server down, connection dropped mid-request) — not on HTTP errors.
        msg = 'Could not reach the SnapStudy server — is it running on port 3002? Start it, then press “Try again”.';
      } else {
        msg = String(err.message || err);
      }
      $('error-detail').textContent = msg.slice(0, 400);
      show('error');
    }
  }

  // ---------- render ----------
  function renderResults() {
    const d = state.data;

    // provider badge
    const badge = $('provider-badge');
    badge.textContent = d.providerLabel || 'Gemma 4';
    badge.classList.remove('hidden');

    // notice (e.g. text-only fallback)
    const notice = $('notice-bar');
    if (d.notice) {
      notice.textContent = '⚠️ ' + d.notice;
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }

    $('result-thumb').src = state.previewUrl;
    applyStaticI18n();

    // summary — the model writes markdown; render it (sanitized), fall back to text
    if (window.marked && window.DOMPurify) {
      $('summary-content').innerHTML = DOMPurify.sanitize(marked.parse(d.summary || '—'));
    } else {
      $('summary-content').textContent = d.summary || '—';
    }

    // flashcards
    const grid = $('flashcards-grid');
    grid.innerHTML = '';
    (d.flashcards || []).forEach((card) => {
      const el = document.createElement('div');
      el.className = 'flashcard';
      el.innerHTML = `
        <div class="fc-inner">
          <div class="fc-face fc-front"><span class="fc-tag">${t('front')}</span><div></div></div>
          <div class="fc-face fc-back"><span class="fc-tag">${t('back')}</span><div></div></div>
        </div>`;
      el.querySelector('.fc-front div').textContent = card.front;
      el.querySelector('.fc-back div').textContent = card.back;
      el.addEventListener('click', () => el.classList.toggle('flipped'));
      grid.appendChild(el);
    });

    renderQuiz();
    switchTab('summary');
  }

  function renderQuiz() {
    const area = $('quiz-area');
    area.innerHTML = '';
    const quiz = state.data.quiz || [];
    state.quizAnswers = new Array(quiz.length).fill(null);

    quiz.forEach((q, qi) => {
      const box = document.createElement('div');
      box.className = 'quiz-q';
      const h = document.createElement('h3');
      const num = document.createElement('span');
      num.className = 'qnum';
      num.textContent = `Q${qi + 1}.`;
      h.appendChild(num);
      h.appendChild(document.createTextNode(' ' + q.question));
      box.appendChild(h);

      const opts = document.createElement('div');
      opts.className = 'quiz-opts';
      q.options.forEach((opt, oi) => {
        const b = document.createElement('button');
        b.className = 'quiz-opt';
        b.textContent = `${String.fromCharCode(65 + oi)}. ${opt}`;
        b.addEventListener('click', () => {
          if (state.quizAnswers[qi] !== null) return;
          state.quizAnswers[qi] = oi;
          [...opts.children].forEach((btn, bi) => {
            btn.disabled = true;
            if (bi === q.answerIndex) btn.classList.add('correct');
            else if (bi === oi) btn.classList.add('wrong');
          });
          if (q.explanation) {
            const ex = document.createElement('div');
            ex.className = 'quiz-expl';
            ex.textContent = '💡 ' + q.explanation;
            box.appendChild(ex);
          }
          maybeShowScore();
        });
        opts.appendChild(b);
      });
      box.appendChild(opts);
      area.appendChild(box);
    });

    function maybeShowScore() {
      if (state.quizAnswers.some((a) => a === null)) return;
      const score = state.quizAnswers.filter((a, i) => a === quiz[i].answerIndex).length;
      const card = document.createElement('div');
      card.className = 'quiz-score';
      const h3 = document.createElement('h3');
      h3.textContent = t('scoreTitle')(score, quiz.length);
      const p = document.createElement('p');
      p.textContent = t('scoreSub');
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = t('retake');
      btn.addEventListener('click', renderQuiz);
      card.append(h3, p, btn);
      area.appendChild(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((tabEl) =>
      tabEl.classList.toggle('active', tabEl.dataset.tab === name)
    );
    ['summary', 'flashcards', 'quiz'].forEach((p) =>
      $('panel-' + p).classList.toggle('hidden', p !== name)
    );
  }

  // ---------- health badge on load ----------
  fetch('/api/health')
    .then((r) => r.json())
    .then((h) => {
      if (h.ok) {
        const badge = $('provider-badge');
        badge.textContent = h.providerLabel;
        badge.classList.remove('hidden');
      }
    })
    .catch(() => {});
})();
