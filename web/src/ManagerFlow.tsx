import { useState } from 'react';
import type { SurveyListing } from '@api/tenancy/contract.js';
import type { WeeklySummary } from '@api/summary/weekly-summary.js';
import { api } from './api';
import { ErrorPanel, Loading, NoticePanel } from './Feedback';
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
        {summary.questions.map((question, index) => (
          <div key={question.id} className="rollup-row">
            <dt>Question {index + 1}</dt>
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
  const [selected, setSelected] = useState<string | null>(null);
  const { state, reload } = useAsync(() => api<SurveyListing[]>('/surveys', { token }), [token]);

  if (state.status === 'loading') return <Loading what="your surveys" />;
  if (state.status === 'error') return <ErrorPanel message={state.error.message} onRetry={reload} />;
  if (state.data.length === 0) {
    return <NoticePanel>Your organization has no surveys yet.</NoticePanel>;
  }

  const surveyId = selected ?? state.data[0].id;

  return (
    <>
      <section className="card">
        <label htmlFor="survey">Survey</label>
        <select
          id="survey"
          value={surveyId}
          onChange={(event) => setSelected(event.target.value)}
        >
          {state.data.map((survey) => (
            <option key={survey.id} value={survey.id}>
              {survey.title} ({survey.status})
            </option>
          ))}
        </select>
      </section>

      <Summary surveyId={surveyId} token={token} />
    </>
  );
}
