import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-white">
      <nav className="border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-[#0A1F44]">Brillianda</h1>
          <div className="flex gap-4">
            <Link
              href="/login"
              className="px-4 py-2 text-sm font-medium text-[#0A1F44] border border-[#0A1F44] rounded-md hover:bg-[#0A1F44] hover:text-white transition-colors"
            >
              Login
            </Link>
          </div>
        </div>
      </nav>

      <section className="max-w-6xl mx-auto px-6 py-24 text-center">
        <h2 className="text-5xl font-bold text-[#0A1F44] mb-6">
          School Registry, LMS & CBT
        </h2>
        <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">
          The next-generation platform for managing schools, classes, exams, and student performance — all in one place.
        </p>
        <div className="flex gap-4 justify-center">
          <Link
            href="/login"
            className="px-8 py-3 bg-[#0D0D0D] text-white font-medium rounded-md hover:bg-[#FF6B00] transition-colors"
          >
            Get Started
          </Link>
        </div>
      </section>

      <section className="bg-gray-50 py-20">
        <div className="max-w-6xl mx-auto px-6 grid md:grid-cols-3 gap-8">
          {[
            { title: 'Multi-Tenancy', desc: 'Each school gets its own branded subdomain and isolated data.' },
            { title: 'Exam Management', desc: 'Teachers can build exams with multiple-choice questions and publish instantly.' },
            { title: 'CBT Engine', desc: 'Students take timed, computer-based tests with auto-grading and instant results.' },
          ].map((f) => (
            <div key={f.title} className="p-6 bg-white rounded-xl border border-gray-200 shadow-sm">
              <h3 className="text-lg font-semibold text-[#0A1F44] mb-2">{f.title}</h3>
              <p className="text-gray-600">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
