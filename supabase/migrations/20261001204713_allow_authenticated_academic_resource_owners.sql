alter policy "Teachers can create own courses"
on public.courses
to authenticated
with check (
  teacher_id = (select auth.uid())
);

alter policy "Teachers can read own courses"
on public.courses
to authenticated
using (
  teacher_id = (select auth.uid())
);

alter policy "Teachers can update own courses"
on public.courses
to authenticated
using (
  teacher_id = (select auth.uid())
)
with check (
  teacher_id = (select auth.uid())
);

alter policy "Teachers can delete own courses"
on public.courses
to authenticated
using (
  teacher_id = (select auth.uid())
);

alter policy "Teachers can create quizzes in own courses"
on public.quizzes
to authenticated
with check (
  created_by = (select auth.uid())
  and private.owns_course(course_id)
);

alter policy "Teachers can create sessions for own quizzes"
on public.quiz_sessions
to authenticated
with check (
  created_by = (select auth.uid())
  and exists (
    select 1
    from public.quizzes q
    where q.id = quiz_sessions.quiz_id
      and private.owns_course(q.course_id)
  )
);
