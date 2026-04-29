'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Question {
  text: string;
  points: number;
  order: number;
  options: { text: string; isCorrect: boolean; order: number }[];
}

export default function NewExamPage() {
  const router = useRouter();
  const [subjects, setSubjects] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [instructions, setInstructions] = useState('');
  const [questions, setQuestions] = useState<Question[]>([
    { text: '', points: 1, order: 1, options: [
      { text: '', isCorrect: false, order: 1 },
      { text: '', isCorrect: false, order: 2 },
    ]},
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/teacher/dashboard').then((res) => {
      if (res.data.success) setSubjects(res.data.data.subjects);
    });
  }, []);

  const addQuestion = () => {
    setQuestions([...questions, {
      text: '', points: 1, order: questions.length + 1,
      options: [
        { text: '', isCorrect: false, order: 1 },
        { text: '', isCorrect: false, order: 2 },
      ]
    }]);
  };

  const updateQuestion = (idx: number, field: keyof Question, value: any) => {
    const updated = [...questions];
    updated[idx] = { ...updated[idx], [field]: value };
    setQuestions(updated);
  };

  const updateOption = (qIdx: number, oIdx: number, field: string, value: any) => {
    const updated = [...questions];
    updated[qIdx].options = updated[qIdx].options.map((o, i) =>
      i === oIdx ? { ...o, [field]: value } : field === 'isCorrect' ? { ...o, isCorrect: false } : o
    );
    setQuestions(updated);
  };

  const addOption = (qIdx: number) => {
    const updated = [...questions];
    updated[qIdx].options.push({ text: '', isCorrect: false, order: updated[qIdx].options.length + 1 });
    setQuestions(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/teacher/exams', {
        title,
        subjectId,
        durationMinutes,
        instructions,
        questions,
      });
      if (res.data.success) router.push('/teacher/exams');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to create exam');
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardShell title="New Exam">
      <PageHeader title="New Exam" />
      <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div>
            <Label>Subject</Label>
            <Select value={subjectId} onValueChange={(v: string | null) => v && setSubjectId(v)}>
              <SelectTrigger><SelectValue placeholder="Select subject" /></SelectTrigger>
              <SelectContent>
                {subjects.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Duration (minutes)</Label>
            <Input type="number" min={1} value={durationMinutes} onChange={(e) => setDurationMinutes(Number(e.target.value))} required />
          </div>
          <div>
            <Label>Instructions</Label>
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-[#0A1F44]">Questions</h3>
          {questions.map((q, qIdx) => (
            <div key={qIdx} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
              <div>
                <Label>Question {qIdx + 1}</Label>
                <Textarea value={q.text} onChange={(e) => updateQuestion(qIdx, 'text', e.target.value)} required />
              </div>
              <div>
                <Label>Points</Label>
                <Input type="number" min={1} value={q.points} onChange={(e) => updateQuestion(qIdx, 'points', Number(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>Options</Label>
                {q.options.map((o, oIdx) => (
                  <div key={oIdx} className="flex items-center gap-3">
                    <input
                      type="radio"
                      name={`correct-${qIdx}`}
                      checked={o.isCorrect}
                      onChange={() => updateOption(qIdx, oIdx, 'isCorrect', true)}
                      className="w-4 h-4 accent-[#FF6B00]"
                    />
                    <Input
                      value={o.text}
                      onChange={(e) => updateOption(qIdx, oIdx, 'text', e.target.value)}
                      placeholder={`Option ${oIdx + 1}`}
                      required
                    />
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => addOption(qIdx)}>
                  Add Option
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" onClick={addQuestion}>Add Question</Button>
        </div>

        <div className="flex gap-3">
          <Button type="submit" disabled={saving} className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
            {saving ? 'Saving...' : 'Create Exam'}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push('/teacher/exams')}>
            Cancel
          </Button>
        </div>
      </form>
    </DashboardShell>
  );
}
