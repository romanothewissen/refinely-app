const state = {
  response: null,
};

const requirementEl = document.querySelector('#requirement');
const providerEl = document.querySelector('#provider');
const maxContextCardsEl = document.querySelector('#maxContextCards');
const jsaTextEl = document.querySelector('#jsaText');
const runButton = document.querySelector('#runButton');
const statusPill = document.querySelector('#statusPill');
const overallScore = document.querySelector('#overallScore');
const scoreGrid = document.querySelector('#scoreGrid');

const panels = {
  features: document.querySelector('#featuresPanel'),
  plan: document.querySelector('#planPanel'),
  evidence: document.querySelector('#evidencePanel'),
  comparison: document.querySelector('#comparisonPanel'),
  raw: document.querySelector('#rawPanel'),
};

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    panels[tab.dataset.tab].classList.add('active');
  });
});

runButton.addEventListener('click', runPipeline);

renderEmpty();

async function runPipeline() {
  const requirement = requirementEl.value.trim();
  if (!requirement) {
    setStatus('Add a requirement', true);
    return;
  }

  runButton.disabled = true;
  setStatus('Running');

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requirement,
        provider: providerEl.value,
        maxContextCards: Number(maxContextCardsEl.value || 12),
        jsaText: jsaTextEl.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'V3 run failed');
    state.response = payload;
    render(payload);
    setStatus('Complete');
  } catch (error) {
    setStatus('Failed', true);
    panels.features.innerHTML = `<div class="empty-state">${escapeHtml(error.message || String(error))}</div>`;
  } finally {
    runButton.disabled = false;
  }
}

function render(payload) {
  renderScore(payload.score);
  renderFeatures(payload.result);
  renderPlan(payload.result);
  renderEvidence(payload.result);
  renderComparison(payload.score);
  panels.raw.innerHTML = `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
}

function renderScore(score) {
  overallScore.textContent = score.overall;
  scoreGrid.innerHTML = score.dimensions.map((dimension) => `
    <div class="score-tile">
      <strong>${dimension.score}</strong>
      <span>${escapeHtml(dimension.label)}</span>
      <span>${escapeHtml(dimension.note)}</span>
    </div>
  `).join('');
}

function renderFeatures(result) {
  if (!result.draft.features.length) {
    panels.features.innerHTML = '<div class="empty-state">No features returned.</div>';
    return;
  }

  panels.features.innerHTML = `
    ${result.draft.blockingQuestions?.length ? `
      <article class="feature-card">
        <header class="feature-head">
          <div>
            <h2>Open questions</h2>
            <p>Scope details that should be resolved before Jira writeback.</p>
          </div>
        </header>
        <ul class="question-list">
          ${result.draft.blockingQuestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </article>
    ` : ''}
    <div class="feature-list">
      ${result.draft.features.map((feature, index) => `
        <article class="feature-card">
          <header class="feature-head">
            <div>
              <h2>${index + 1}. ${escapeHtml(feature.summary)}</h2>
              <p>${escapeHtml(feature.description)}</p>
              <div class="badge-row">
                ${badge(feature.provenance || 'requirement')}
                ${feature.openQuestions?.length ? `<span class="badge miss">${feature.openQuestions.length} open question(s)</span>` : ''}
              </div>
            </div>
            <p><strong>Outcome</strong><br>${escapeHtml(feature.businessOutcome)}</p>
          </header>
          <table class="ar-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Given</th>
                <th>When</th>
                <th>Then</th>
                <th>Grounding</th>
              </tr>
            </thead>
            <tbody>
              ${feature.acceptanceRequirements.map((ar, arIndex) => `
                <tr>
                  <td>${arIndex + 1}</td>
                  <td>${escapeHtml(ar.given)}</td>
                  <td>${escapeHtml(ar.when)}</td>
                  <td>${escapeHtml(ar.then)}</td>
                  <td>
                    ${badge(ar.provenance || 'requirement')}
                    <div class="badge-row">${(ar.evidenceRefs || []).map((ref) => `<span class="badge">${escapeHtml(ref.cardId)}</span>`).join('')}</div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </article>
      `).join('')}
    </div>
  `;
}

function renderPlan(result) {
  const sizing = result.capabilityPlan.sizingAssessment;
  panels.plan.innerHTML = `
    <div class="plan-list">
      <div class="comparison-item">
        <strong>Complexity:</strong> ${escapeHtml(result.capabilityPlan.complexity)}
        <span class="muted"> · Planner: ${escapeHtml(result.diagnostics.planner)} · Generator: ${escapeHtml(result.diagnostics.generator)}</span>
      </div>
      ${sizing ? `
        <article class="plan-item">
          <h2>Sizing assessment</h2>
          <p>${escapeHtml(sizing.reasoningSummary)}</p>
          <div class="badge-row">
            <span class="badge">${escapeHtml(sizing.clarity)} clarity</span>
            <span class="badge">${escapeHtml(sizing.ambiguityLevel)} ambiguity</span>
            <span class="badge">${escapeHtml(sizing.decompositionStyle.replace(/_/g, ' '))}</span>
            <span class="badge">${sizing.recommendedFeatureRange.min}-${sizing.recommendedFeatureRange.max} feature range</span>
          </div>
          ${sizing.candidateCapabilities?.length ? `
            <div class="diagnostic-block">
              <strong>Candidate splits</strong>
              <div class="coverage-grid">
                ${sizing.candidateCapabilities.map((candidate) => `<span class="badge">${escapeHtml(candidate.label)} · ${escapeHtml(candidate.confidence)}</span>`).join('')}
              </div>
            </div>
          ` : ''}
        </article>
      ` : ''}
      ${result.capabilityPlan.capabilities.map((capability, index) => `
        <article class="plan-item">
          <h2>${index + 1}. ${escapeHtml(capability.label)}</h2>
          <p>${escapeHtml(capability.businessOutcome)}</p>
          <div class="badge-row">
            ${capability.acceptanceFocus.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join('')}
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderEvidence(result) {
  panels.evidence.innerHTML = `
    <div class="evidence-list">
      ${result.contextPack.cards.map((card) => `
        <article class="evidence-item">
          <div>
            ${badge(card.sourceKind)}
            <p class="muted">${escapeHtml(card.id)}</p>
            <p class="muted">score ${Number(card.score).toFixed(2)}</p>
          </div>
          <div>
            <strong>${escapeHtml(card.title)}</strong>
            <p>${escapeHtml(card.text)}</p>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderComparison(score) {
  const coverage = score.expectedCapabilityCoverage || [];
  panels.comparison.innerHTML = `
    <div class="comparison-layout">
      <article class="comparison-item">
        <strong>V3 counts</strong>
        <p class="muted">${score.counts.features} features · ${score.counts.acceptanceRequirements} ARs · ${score.counts.evidenceRefs} evidence refs</p>
      </article>
      ${score.jsaComparison ? `
        <article class="comparison-item">
          <strong>${score.jsaComparison.benchmarkLabel ? 'JSA benchmark' : 'JSA pasted output'}</strong>
          <p class="muted">${score.jsaComparison.alignmentScore} alignment · ${score.jsaComparison.featureCount} feature signals · ${score.jsaComparison.acceptanceRequirementCount} GIVEN clauses</p>
          <div class="badge-row">${score.jsaComparison.signals.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join('')}</div>
          ${score.jsaComparison.vagueAcceptanceRequirementCount ? `
            <p class="muted">Vague ARs: ${score.jsaComparison.vagueAcceptanceRequirementCount}</p>
          ` : ''}
          ${score.jsaComparison.missingRequiredTerms?.length ? `
            <p class="muted">Missing: ${score.jsaComparison.missingRequiredTerms.slice(0, 8).map(escapeHtml).join(', ')}</p>
          ` : ''}
          ${score.jsaComparison.missingScenarioTerms?.length ? `
            <div class="diagnostic-block">
              <strong>Missing concrete scenarios</strong>
              <div class="coverage-grid">${score.jsaComparison.missingScenarioTerms.slice(0, 12).map((item) => `<span class="badge miss">${escapeHtml(item)}</span>`).join('')}</div>
            </div>
          ` : ''}
          ${score.jsaComparison.prohibitedTermsFound?.length ? `
            <p class="muted">Overreach: ${score.jsaComparison.prohibitedTermsFound.slice(0, 8).map(escapeHtml).join(', ')}</p>
          ` : ''}
          ${score.jsaComparison.questionOnlyTermsFound?.length ? `
            <div class="diagnostic-block">
              <strong>Should have been questions</strong>
              <div class="coverage-grid">${score.jsaComparison.questionOnlyTermsFound.slice(0, 8).map((item) => `<span class="badge miss">${escapeHtml(item)}</span>`).join('')}</div>
            </div>
          ` : ''}
          ${score.jsaComparison.suggestedOpenQuestions?.length ? `
            <div class="diagnostic-block">
              <strong>Suggested open questions</strong>
              <ul class="question-list">${score.jsaComparison.suggestedOpenQuestions.slice(0, 6).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
            </div>
          ` : ''}
        </article>
      ` : `
        <article class="comparison-item">
          <strong>No JSA output pasted</strong>
          <p class="muted">Paste JSA output above to compare feature usefulness, coverage, and overreach signals.</p>
        </article>
      `}
      ${score.qualityWarnings?.length ? `
        <article class="comparison-item">
          <strong>Why this may feel weak</strong>
          <div class="coverage-grid">
            ${score.qualityWarnings.map((item) => `<span class="badge miss">${escapeHtml(item)}</span>`).join('')}
          </div>
        </article>
      ` : ''}
      <article class="comparison-item">
        <strong>Requirement-derived coverage</strong>
        <div class="coverage-grid">
          ${coverage.map((item) => `<span class="badge ${item.covered ? '' : 'miss'}">${item.covered ? 'covered' : 'missing'} · ${escapeHtml(item.label)}</span>`).join('')}
        </div>
      </article>
    </div>
  `;
}

function renderEmpty() {
  panels.features.innerHTML = '<div class="empty-state">Enter a requirement and run V3 to see features here.</div>';
  panels.plan.innerHTML = '<div class="empty-state">Capability plan appears after a run.</div>';
  panels.evidence.innerHTML = '<div class="empty-state">Retrieved WI/backlog context appears after a run.</div>';
  panels.comparison.innerHTML = '<div class="empty-state">Scores and JSA comparison appear after a run.</div>';
  panels.raw.innerHTML = '<pre>{}</pre>';
}

function badge(value) {
  const normalized = String(value || 'unknown');
  return `<span class="badge provenance-${escapeHtml(normalized)}">${escapeHtml(normalized.replace(/_/g, ' '))}</span>`;
}

function setStatus(value, isError = false) {
  statusPill.textContent = value;
  statusPill.style.color = isError ? 'var(--red)' : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
