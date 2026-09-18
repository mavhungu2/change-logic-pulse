import { useEffect, useState } from 'react';
import type { SurveyListing } from '@api/tenancy/contract.js';
import type { WeeklySummary } from '@api/summary/weekly-summary.js';
import { api } from './api';
import { ErrorPanel, Loading, NoticePanel } from './Feedback';
import { readParam, writeParams } from './url';
import { useAsync } from './useAsync';

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

function Summary({ surveyId, token }: { surveyId: string; token: string }) {
  const { state, reload } = useAsync(
    () => api<WeeklySummary>(`/surveys/${surveyId}/summary`, { token }),
    [surveyId, token],
  );

  if (state.status === 'loading') return <Loading what="the weekly summary" />;
  if (state.status === 'error') return <ErrorPanel message={state.error.message} onRetry={reload} />;

  const summary = state.data;
  return (
    <section className="card">
      <h3>Week of {summary.weekStart}</h3>

      <p className="headline">
        {summary.completedCount} of {summary.eligibleCount} members responded{' '}
        <span className="rate">{percent(summary.completionRate)}</span>
      </p>
      <p className="muted">Managers are not counted — the denominator is members.</p>

      {/* Numbers, not charts: §1 rules charting libraries out of scope. */}
      <dl className="rollup">
        {summary.questions.map((question) => (
          <div key={question.id} className="rollup-row">
            <dt>{question.text}</dt>
            <dd>
              {question.type === 'rating' ? (
                question.average === null ? (
                  <span className="muted">No answers yet</span>
                ) : (
                  <>
                    <strong>{question.average}</strong> average from {question.count}{' '}
                    {question.count === 1 ? 'answer' : 'answers'}
                  </>
                )
              ) : (
                <>
                  <strong>{question.counts.yes}</strong> yes ·{' '}
                  <strong>{question.counts.no}</strong> no
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ManagerFlow({ token }: { token: string }) {
  // Seeded from the URL, so a summary is linkable. See url.ts for why there is
  // no organization in that link and cannot be one.
  const [selected, setSelected] = useState<string | null>(() => readParam('survey'));
  const { state, reload } = useAsync(() => api<SurveyListing[]>('/surveys', { token }), [token]);

  const resolved = selected ?? (state.status === 'ready' ? (state.data[0]?.id ?? null) : null);

  // Put the survey actually being read into the address bar, so the link is
  // copyable without having touched the dropdown first.
  useEffect(() => {
    if (resolved !== null && readParam('survey') !== resolved) writeParams({ survey: resolved });
  }, [resolved]);

  if (state.status === 'loading') return <Loading what="your surveys" />;
  if (state.status === 'error') return <ErrorPanel message={state.error.message} onRetry={reload} />;
  if (state.data.length === 0) {
    return <NoticePanel>Your organization has no surveys yet.</NoticePanel>;
  }

  const surveyId = resolved ?? state.data[0].id;
  // A ?survey= naming a survey this manager cannot see. Usually that means
  // somebody pasted another organization's id, which is the interesting case:
  // the request still goes out, and the API answers 404 rather than 403,
  // because from inside this tenant the row is indistinguishable from one that
  // never existed. The dropdown says the id is not yours; the API never does.
  const isOwn = state.data.some((survey) => survey.id === surveyId);

  function choose(id: string) {
    setSelected(id);
    writeParams({ survey: id });
  }

  return (
    <>
      <section className="card">
        <label htmlFor="survey">Survey</label>
        <select id="survey" value={surveyId} onChange={(event) => choose(event.target.value)}>
          {!isOwn && (
            <option value={surveyId}>Not one of your organization&rsquo;s surveys</option>
          )}
          {state.data.map((survey) => (
            <option key={survey.id} value={survey.id}>
              {survey.title} ({survey.status})
            </option>
          ))}
        </select>
        {!isOwn && (
          <p className="muted">
            <code>{surveyId}</code> is not in your organization. The API answers 404, not 403 —
            it will not confirm that the id belongs to anybody.
          </p>
        )}
      </section>

      <Summary surveyId={surveyId} token={token} />
    </>
  );
}
