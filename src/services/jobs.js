/**
 * Sample role listings with optional resume match scoring.
 * The dataset is a bundled fixture (see src/db/jobs-data.js), not a live feed.
 */
import { db } from '../db/index.js';
import { scoreMatch } from './nlp.js';

export const jobsService = {
  getJobs({ query = '', category = '', remoteOnly = false, resumeText = '' } = {}) {
    let jobs = db.jobs.list({ query, category, remoteOnly });

    const hasResume = typeof resumeText === 'string' && resumeText.trim().length > 0;
    if (hasResume) {
      jobs = jobs
        .map(job => {
          const jobText = `${job.title}. ${job.description} ${(job.skills || []).join(' ')}`;
          const m = scoreMatch(resumeText, jobText);
          return {
            ...job,
            similarityScore: m.similarityScore,
            matchPercentage: m.percentage,
            matchRating: m.matchRating,
            missingKeywords: m.missingKeywords.slice(0, 5)
          };
        })
        .sort((a, b) => b.similarityScore - a.similarityScore);
    }

    return {
      success: true,
      totalCount: jobs.length,
      jobs,
      source: 'Sample role dataset',
      hasResumeMatch: hasResume
    };
  }
};
