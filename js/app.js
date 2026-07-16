(() => {
  const defaultScript = `Welcome to VoicePrompter.

Paste your own script by clicking Edit Script.

When you press Start Listening, the teleprompter listens through your microphone and follows the words you are saying.

It does not simply scroll at a fixed speed. Instead, it searches ahead in your script, finds the phrase you are currently speaking, and moves that phrase toward the guide line.

Speak naturally. Small changes in wording are okay, but staying close to the script will give the most accurate results.

Use the manual play mode as a backup, adjust the font size for your camera distance, and enable mirror mode when using reflective teleprompter glass.`;

  const els = {
    stage: document.getElementById('stage'),
    script: document.getElementById('script'),
    editor: document.getElementById('editor'),
    scriptInput: document.getElementById('scriptInput'),
    editBtn: document.getElementById('editBtn'),
    closeEditor: document.getElementById('closeEditor'),
    saveBtn: document.getElementById('saveBtn'),
    clearBtn: document.getElementById('clearBtn'),
    listenBtn: document.getElementById('listenBtn'),
    resetBtn: document.getElementById('resetBtn'),
    fontSize: document.getElementById('fontSize'),
    lineHeight: document.getElementById('lineHeight'),
    followStrength: document.getElementById('followStrength'),
    mirrorBtn: document.getElementById('mirrorBtn'),
    toolbar: document.getElementById('toolbar'),
    mobileMenuBtn: document.getElementById('mobileMenuBtn'),
    mobileMenuClose: document.getElementById('mobileMenuClose'),
    mobileMenuOverlay: document.getElementById('mobileMenuOverlay'),
    manualSpeed: document.getElementById('manualSpeed'),
    manualBtn: document.getElementById('manualBtn'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    toast: document.getElementById('toast')
  };

  const noSleep = typeof window.NoSleep === 'function' ? new window.NoSleep() : null;
  let noSleepEnabled = false;

  function enableNoSleep() {
    if (!noSleep || noSleepEnabled) return;
    try {
      const result = noSleep.enable();
      noSleepEnabled = true;
      if (result && typeof result.catch === 'function') {
        result.catch(() => { noSleepEnabled = false; });
      }
    } catch (_) {
      noSleepEnabled = false;
    }
  }

  function disableNoSleep() {
    if (!noSleep || !noSleepEnabled) return;
    try { noSleep.disable(); } catch (_) {}
    noSleepEnabled = false;
  }

  const state = {
    rawScript: localStorage.getItem('voiceprompter-script') || defaultScript,
    tokens: [],
    normalizedTokens: [],
    currentIndex: 0,
    recognition: null,
    listening: false,
    restartRecognition: false,
    manualPlaying: false,
    manualFrame: null,
    lastFrameTime: 0,
    spokenTrail: [],
    lastMatchedIndex: 0
  };

  function normalizeWord(word) {
    return word
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  function tokenize(text) {
    return text.match(/\S+|\s+/g) || [];
  }

  function renderScript() {
    const pieces = tokenize(state.rawScript);
    state.tokens = [];
    state.normalizedTokens = [];
    els.script.innerHTML = '';

    pieces.forEach(piece => {
      if (/^\s+$/.test(piece)) {
        els.script.appendChild(document.createTextNode(piece));
        return;
      }
      const span = document.createElement('span');
      span.className = 'word upcoming';
      span.textContent = piece;
      span.dataset.wordIndex = state.tokens.length;
      els.script.appendChild(span);
      state.tokens.push(span);
      state.normalizedTokens.push(normalizeWord(piece));
    });

    setCurrentIndex(0, false);
  }

  function setCurrentIndex(index, shouldScroll = true) {
    index = Math.max(0, Math.min(index, state.tokens.length - 1));
    state.currentIndex = index;
    state.lastMatchedIndex = Math.max(state.lastMatchedIndex, index);

    const before = Math.max(0, index - 8);
    const after = Math.min(state.tokens.length, index + 14);

    state.tokens.forEach((token, i) => {
      token.className = 'word ' + (i < before ? 'past' : i === index ? 'current' : 'upcoming');
    });

    if (shouldScroll && state.tokens[index]) {
      const token = state.tokens[index];
      const stageRect = els.stage.getBoundingClientRect();
      const tokenRect = token.getBoundingClientRect();
      const desiredY = stageRect.top + stageRect.height * 0.42;
      const delta = tokenRect.top - desiredY;
      const strength = Number(els.followStrength.value);
      els.stage.scrollBy({ top: delta * strength, behavior: 'smooth' });
    }
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length > 4 && b.length > 4 && (a.startsWith(b) || b.startsWith(a))) return 0.82;

    const max = Math.max(a.length, b.length);
    const min = Math.min(a.length, b.length);
    if (min / max < 0.55) return 0;

    let matches = 0;
    const used = new Set();
    for (const ch of a) {
      for (let i = 0; i < b.length; i++) {
        if (!used.has(i) && b[i] === ch) {
          matches++;
          used.add(i);
          break;
        }
      }
    }
    return matches / max;
  }

  function getVisibleWordRange() {
    const stageRect = els.stage.getBoundingClientRect();
    const topLimit = stageRect.top + 8;
    const bottomLimit = stageRect.bottom - 8;
    let first = null;
    let last = null;

    for (let i = 0; i < state.tokens.length; i++) {
      const rect = state.tokens[i].getBoundingClientRect();
      if (rect.bottom >= topLimit && rect.top <= bottomLimit) {
        if (first === null) first = i;
        last = i;
      } else if (first !== null && rect.top > bottomLimit) {
        break;
      }
    }

    if (first === null) {
      first = state.currentIndex;
      last = Math.min(state.tokens.length - 1, state.currentIndex + 10);
    }

    return { first, last };
  }

  function findBestMatch(spokenWords) {
    const clean = spokenWords.map(normalizeWord).filter(Boolean);
    if (!clean.length) return null;

    const visible = getVisibleWordRange();
    const phrase = clean.slice(-5);

    // Only consider words that are already visible and close to the current position.
    const start = Math.max(state.currentIndex - 2, visible.first);
    const end = Math.min(
      state.normalizedTokens.length,
      visible.last + 1,
      state.currentIndex + 18
    );

    let best = { score: 0, index: state.currentIndex };

    for (let candidate = start; candidate < end; candidate++) {
      let score = 0;
      let comparisons = 0;

      for (let offset = 0; offset < phrase.length; offset++) {
        const scriptIndex = candidate - phrase.length + 1 + offset;
        if (scriptIndex < start || scriptIndex >= end) continue;
        const s = similarity(phrase[offset], state.normalizedTokens[scriptIndex]);
        score += s * (0.8 + offset / phrase.length);
        comparisons++;
      }

      if (comparisons) score /= comparisons;

      // Strongly prefer the next few words over farther visible duplicates.
      const forwardDistance = candidate - state.currentIndex;
      if (forwardDistance < 0) score -= 0.18;
      else score -= Math.min(forwardDistance * 0.018, 0.22);

      if (score > best.score) best = { score, index: candidate };
    }

    return best.score >= 0.48 ? best : null;
  }

  function handleTranscript(text, isFinal) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;

    if (isFinal) {
      state.spokenTrail.push(...words);
      state.spokenTrail = state.spokenTrail.slice(-14);
    }

    const working = [...state.spokenTrail, ...words].slice(-14);
    const result = findBestMatch(working);

    if (result) {
      // Advance only a small amount at a time, and move to the word after the one just spoken.
      const cappedIndex = Math.min(result.index, state.currentIndex + 6);
      const nextIndex = Math.min(state.tokens.length - 1, Math.max(state.currentIndex, cappedIndex + 1));
      if (nextIndex > state.currentIndex) {
        setCurrentIndex(nextIndex, true);
      }
      els.statusText.textContent = `Following: “${words.slice(-4).join(' ')}”`;
    }
  }

  function setupRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      state.listening = true;
      els.listenBtn.textContent = 'Stop Listening';
      els.listenBtn.classList.add('active');
      els.statusDot.classList.add('listening');
      els.statusText.textContent = 'Listening…';
    };

    recognition.onresult = event => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += transcript + ' ';
        else interim += transcript + ' ';
      }
      if (interim) handleTranscript(interim, false);
      if (finalText) handleTranscript(finalText, true);
    };

    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        state.restartRecognition = false;
        stopListening();
        toast('Microphone permission was denied.');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        els.statusText.textContent = `Speech error: ${event.error}`;
      }
    };

    recognition.onend = () => {
      state.listening = false;
      if (state.restartRecognition) {
        setTimeout(() => {
          try { recognition.start(); } catch (_) {}
        }, 250);
      } else {
        els.listenBtn.textContent = 'Start Listening';
        els.listenBtn.classList.remove('active');
        els.statusDot.classList.remove('listening');
        els.statusText.textContent = 'Ready';
      }
    };

    return recognition;
  }

  function startListening() {
    enableNoSleep();
    stopManual();
    if (!state.recognition) state.recognition = setupRecognition();
    if (!state.recognition) {
      toast(isIOS ? 'Voice recognition is unavailable in this Safari version. Update iOS or use Manual Play.' : 'Speech recognition is not available in this browser. Try Chrome, Edge, or Safari.');
      els.statusText.textContent = 'Speech recognition unavailable';
      disableNoSleep();
      return;
    }
    state.restartRecognition = true;
    state.spokenTrail = [];
    try { state.recognition.start(); }
    catch (_) { /* already starting */ }
  }

  function stopListening() {
    disableNoSleep();
    state.restartRecognition = false;
    if (state.recognition) {
      try { state.recognition.stop(); } catch (_) {}
    }
    state.listening = false;
    els.listenBtn.textContent = 'Start Listening';
    els.listenBtn.classList.remove('active');
    els.statusDot.classList.remove('listening');
    els.statusText.textContent = 'Ready';
  }

  function manualLoop(timestamp) {
    if (!state.manualPlaying) return;
    if (!state.lastFrameTime) state.lastFrameTime = timestamp;
    const delta = (timestamp - state.lastFrameTime) / 1000;
    state.lastFrameTime = timestamp;
    const speed = Number(els.manualSpeed.value);
    els.stage.scrollTop += speed * delta;
    state.manualFrame = requestAnimationFrame(manualLoop);
  }

  function startManual() {
    stopListening();
    state.manualPlaying = true;
    state.lastFrameTime = 0;
    els.manualBtn.textContent = 'Pause Manual';
    els.manualBtn.classList.add('active');
    els.statusText.textContent = 'Manual scrolling';
    state.manualFrame = requestAnimationFrame(manualLoop);
  }

  function stopManual() {
    state.manualPlaying = false;
    els.manualBtn.textContent = 'Manual Play';
    els.manualBtn.classList.remove('active');
    if (state.manualFrame) cancelAnimationFrame(state.manualFrame);
    state.manualFrame = null;
    state.lastFrameTime = 0;
  }

  function reset() {
    stopManual();
    stopListening();
    state.spokenTrail = [];
    state.lastMatchedIndex = 0;
    els.stage.scrollTop = 0;
    setCurrentIndex(0, false);
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2400);
  }

  els.editBtn.onclick = () => {
    els.scriptInput.value = state.rawScript;
    els.editor.classList.add('open');
    els.scriptInput.focus();
  };
  els.closeEditor.onclick = () => els.editor.classList.remove('open');
  els.clearBtn.onclick = () => els.scriptInput.value = '';
  els.saveBtn.onclick = () => {
    const text = els.scriptInput.value.trim();
    if (!text) return toast('Paste a script first.');
    state.rawScript = text;
    localStorage.setItem('voiceprompter-script', text);
    renderScript();
    els.stage.scrollTop = 0;
    els.editor.classList.remove('open');
    toast('Script loaded.');
  };

  els.listenBtn.onclick = () => state.listening || state.restartRecognition ? stopListening() : startListening();
  els.resetBtn.onclick = reset;
  els.manualBtn.onclick = () => state.manualPlaying ? stopManual() : startManual();

  els.fontSize.oninput = () => document.documentElement.style.setProperty('--font-size', `${els.fontSize.value}px`);
  els.lineHeight.oninput = () => document.documentElement.style.setProperty('--line-height', (els.lineHeight.value / 100).toFixed(2));

  els.mirrorBtn.onclick = () => {
    els.stage.classList.toggle('mirror');
    els.mirrorBtn.classList.toggle('active');
  };

  function setMobileMenu(open) {
    els.toolbar.classList.toggle('open', open);
    els.mobileMenuOverlay.classList.toggle('open', open);
    els.mobileMenuBtn.setAttribute('aria-expanded', String(open));
  }

  els.mobileMenuBtn.onclick = () => setMobileMenu(true);
  els.mobileMenuClose.onclick = () => setMobileMenu(false);
  els.mobileMenuOverlay.onclick = () => setMobileMenu(false);

  els.toolbar.addEventListener('click', event => {
    if (window.matchMedia('(hover: none), (pointer: coarse)').matches && event.target.matches('button:not(#mobileMenuClose)')) {
      setMobileMenu(false);
    }
  });


  document.addEventListener('keydown', event => {
    if (els.editor.classList.contains('open')) {
      if (event.key === 'Escape') els.editor.classList.remove('open');
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      state.listening || state.restartRecognition ? stopListening() : startListening();
    }
    if (event.key.toLowerCase() === 'r') reset();
    if (event.key.toLowerCase() === 'm') els.mirrorBtn.click();
    if (event.key === 'ArrowDown') els.stage.scrollBy({ top: 80, behavior: 'smooth' });
    if (event.key === 'ArrowUp') els.stage.scrollBy({ top: -80, behavior: 'smooth' });
  });

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (!window.isSecureContext && location.protocol !== 'file:') {
    els.statusText.textContent = 'HTTPS required for microphone access';
    setTimeout(() => toast('Microphone access requires an HTTPS-hosted page.'), 500);
  } else if (isIOS && isSafari) {
    els.statusText.textContent = 'Ready for iOS Safari';
  }

  document.addEventListener('touchmove', event => {
    if (els.editor.classList.contains('open')) return;
  }, { passive: true });

  renderScript();
})();
