'use client';

import { useState, useCallback, useEffect } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useExamTimer } from '@/hooks/useExamTimer';
import { CountdownTimer } from './CountdownTimer';

interface Question {
  id: string;
  text: string;
  points: number;
  options: { id: string; text: string }[];
}

interface CBTInterfaceProps {
  examId: string;
  attemptId: string;
  durationMinutes: number;
  startTime: string;
  questions: Question[];
  onSubmitted: () => void;
}

export function CBTInterface({ examId, attemptId, durationMinutes, startTime, questions, onSubmitted }: CBTInterfaceProps) {
  const [answers, setAnswers] = useState<Map<string, string | null>>(new Map());
  const [currentIndex, setCurrentIndex] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expiredOpen, setExpiredOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleExpire = useCallback(() => {
    setExpiredOpen(true);
    handleSubmit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { remainingSeconds, formattedTime, isExpired, isWarning } = useExamTimer({
    durationMinutes,
    startTime,
    attemptId,
    onExpire: handleExpire,
  });

  const selectAnswer = (questionId: string, optionId: string) => {
    setAnswers((prev) => new Map(prev).set(questionId, optionId));
  };

  const handleSubmit = async (forced = false) => {
    if (!forced && answers.size < questions.length) {
      setConfirmOpen(true);
      return;
    }
    setSubmitting(true);
    try {
      const payload = questions.map((q) => ({
        questionId: q.id,
        selectedOptionId: answers.get(q.id) || null,
      }));
      await api.post(`/student/exams/${examId}/submit`, { attemptId, answers: payload });
      onSubmitted();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  const currentQuestion = questions[currentIndex];
  const allAnswered = questions.every((q) => answers.has(q.id));

  return (
    <div className="min-h-screen bg-gray-50">
      <CountdownTimer formattedTime={formattedTime} isWarning={isWarning} isExpired={isExpired} />
      <div className="pt-16 flex">
        {/* Sidebar */}
        <aside className="w-20 md:w-64 bg-white border-r border-gray-200 fixed left-0 top-12 bottom-0 overflow-y-auto p-4">
          <p className="text-sm font-medium text-gray-500 mb-3 hidden md:block">Questions</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {questions.map((q, idx) => {
              const answered = answers.has(q.id);
              return (
                <button
                  key={q.id}
                  onClick={() => setCurrentIndex(idx)}
                  className={`w-8 h-8 md:w-10 md:h-10 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                    idx === currentIndex
                      ? 'bg-[#0A1F44] text-white'
                      : answered
                      ? 'bg-green-100 text-green-800 border border-green-300'
                      : 'bg-gray-100 text-gray-600 border border-gray-300'
                  }`}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
          <div className="mt-6 hidden md:block">
            <p className="text-xs text-gray-500">
              Answered: {answers.size} / {questions.length}
            </p>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 ml-20 md:ml-64 p-4 md:p-8">
          <div className="max-w-3xl mx-auto bg-white rounded-xl border border-gray-200 shadow-sm p-6 md:p-8">
            <div className="mb-6">
              <p className="text-sm text-gray-500 mb-2">Question {currentIndex + 1} of {questions.length}</p>
              <h2 className="text-lg font-medium text-[#0A1F44]">{currentQuestion.text}</h2>
            </div>
            <div className="space-y-3">
              {currentQuestion.options.map((opt) => {
                const selected = answers.get(currentQuestion.id) === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => selectAnswer(currentQuestion.id, opt.id)}
                    className={`w-full text-left px-4 py-3 rounded-md border transition-colors ${
                      selected
                        ? 'bg-[#FF6B00] text-white border-[#FF6B00]'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {opt.text}
                  </button>
                );
              })}
            </div>
            <div className="flex justify-between mt-8">
              <Button
                variant="outline"
                onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                disabled={currentIndex === 0}
              >
                Prev
              </Button>
              {currentIndex < questions.length - 1 ? (
                <Button
                  className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]"
                  onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
                >
                  Next
                </Button>
              ) : (
                <Button
                  className="bg-green-600 text-white hover:bg-green-700"
                  onClick={() => handleSubmit(false)}
                  disabled={submitting || isExpired}
                >
                  {submitting ? 'Submitting...' : 'Submit'}
                </Button>
              )}
            </div>
          </div>
        </main>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit Exam?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            You have answered {answers.size} of {questions.length} questions. Are you sure you want to submit?
          </p>
          <div className="flex gap-3 justify-end mt-4">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button className="bg-green-600 text-white hover:bg-green-700" onClick={() => { setConfirmOpen(false); handleSubmit(true); }}>
              Submit
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={expiredOpen} onOpenChange={setExpiredOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Time's Up!</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">Your exam has been automatically submitted.</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
