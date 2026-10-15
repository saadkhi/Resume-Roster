/**
 * Generates the bundled sample resumes in /uploads.
 * All personas, employers and contact details are fictional.
 * Run with: node scripts/create-sample-resumes.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function createPdfBuffer(lines) {
  let out = '%PDF-1.4\n';
  const offsets = [];
  const addObj = (str) => {
    offsets.push(Buffer.byteLength(out));
    out += str + '\n';
  };
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  addObj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj');
  const stream = lines
    .map((line, i) => `BT /F1 10 Tf 48 ${760 - i * 14} Td (${esc(line)}) Tj ET`)
    .join('\n');
  addObj('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj');
  addObj(`4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj`);
  addObj('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj');

  const xref = Buffer.byteLength(out);
  out += `xref\n0 6\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}

const SAMPLES = {
  'sample-data-scientist.pdf': [
    'Priya Raman',
    'priya.raman@example.com | (555) 010-4421 | Austin, TX | linkedin.com/in/priya-raman-example',
    '',
    'SUMMARY',
    'Data scientist with 4 years of experience building forecasting and classification models in Python and SQL.',
    '',
    'EXPERIENCE',
    'Data Scientist, Brightloop Analytics (2022 - Present)',
    '- Built churn prediction models with scikit-learn and XGBoost, improving retention campaign precision by 23%.',
    '- Designed A/B testing framework and statistical analysis used by 6 product teams.',
    '- Automated feature pipelines in Airflow and SQL, reducing weekly reporting time by 15 hours.',
    'Junior Data Analyst, Northgate Retail (2020 - 2022)',
    '- Created Tableau dashboards tracking revenue and inventory KPIs for 40+ stores.',
    '- Performed regression analysis to forecast demand with 91% accuracy.',
    '',
    'SKILLS',
    'Languages: Python, SQL, R',
    'Machine Learning: scikit-learn, XGBoost, TensorFlow, statistics, deep learning, predictive modeling',
    'Tools: Pandas, NumPy, Airflow, Tableau, Git, Docker, AWS',
    '',
    'PROJECTS',
    'Demand Forecasting Service: Time-series model served over a REST API with Flask and Docker.',
    'Customer Segmentation: Clustering and visualization of 2M customer records.',
    '',
    'EDUCATION',
    'M.S. Statistics, University of Texas (2018 - 2020)',
    'B.S. Mathematics, State College (2014 - 2018)'
  ],
  'sample-software-engineer.pdf': [
    'Daniel Okafor',
    'daniel.okafor@example.com | (555) 010-7788 | Seattle, WA | github.com/example-dokafor',
    '',
    'SUMMARY',
    'Backend engineer with 6 years of experience designing distributed systems and microservices in Java and Go.',
    '',
    'EXPERIENCE',
    'Senior Software Engineer, Cloudmart Logistics (2021 - Present)',
    '- Designed event-driven microservices on Kafka handling 12k requests per second.',
    '- Led migration of a monolith to Kubernetes, cutting deployment time from 2 hours to 10 minutes.',
    '- Mentored 5 engineers and ran system design reviews.',
    'Software Engineer, Pinecrest Software (2018 - 2021)',
    '- Built REST APIs in Java and Spring Boot with PostgreSQL and Redis.',
    '- Improved query performance by 60% through indexing and caching.',
    '',
    'SKILLS',
    'Languages: Java, Go, Python, SQL, C++',
    'Systems: Algorithms, data structures, system design, microservices, Kafka, Redis, PostgreSQL',
    'DevOps: Docker, Kubernetes, AWS, Terraform, CI/CD, Git',
    '',
    'PROJECTS',
    'Distributed Rate Limiter: Token bucket service in Go with Redis, open source.',
    'Job Scheduler: Fault-tolerant cron service with leader election.',
    '',
    'EDUCATION',
    'B.S. Computer Science, Lakeview University (2014 - 2018)'
  ],
  'sample-web-developer.pdf': [
    'Mia Alvarez',
    'mia.alvarez@example.com | (555) 010-3302 | Denver, CO | github.com/example-malvarez',
    '',
    'SUMMARY',
    'Front-end developer with 3 years of experience building accessible, responsive React applications.',
    '',
    'EXPERIENCE',
    'Front-End Developer, Pixelharbor (2022 - Present)',
    '- Built a React and TypeScript component library adopted by 4 product teams.',
    '- Improved Lighthouse performance score from 62 to 94 through code splitting and image optimization.',
    '- Implemented responsive design and WCAG accessibility fixes across the checkout flow.',
    'Web Developer Intern, Studio Fern (2021)',
    '- Developed marketing sites in HTML, CSS and JavaScript with a headless CMS.',
    '',
    'SKILLS',
    'Frontend: HTML, CSS, JavaScript, TypeScript, React, Redux, responsive design, accessibility',
    'Backend: Node.js, Express, REST APIs, MongoDB',
    'Tools: Git, Webpack, Jest, Figma',
    '',
    'PROJECTS',
    'Recipe Planner: React and Node.js app with 1,200 monthly users.',
    'Portfolio Generator: Static site generator with Markdown support.',
    '',
    'EDUCATION',
    'B.A. Interaction Design, Riverside College (2017 - 2021)'
  ],
  'sample-junior-developer.pdf': [
    'Sam Whitaker',
    'sam.whitaker@example.com | Portland, OR',
    '',
    'EDUCATION',
    'B.S. Information Systems, Cascade University (2020 - 2024)',
    '',
    'SKILLS',
    'Python, JavaScript, HTML, CSS, SQL, Git',
    '',
    'EXPERIENCE',
    'IT Support Intern, Cascade Health (2023)',
    '- Resolved help desk tickets and maintained workstations.',
    '- Wrote small Python scripts to automate account reports.',
    '',
    'PROJECTS',
    'Task Tracker: Flask app with SQLite for managing personal to-do lists.',
    'Weather Dashboard: JavaScript page using a public weather API.'
  ]
};

const outDir = path.join(root, 'uploads');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, lines] of Object.entries(SAMPLES)) {
  fs.writeFileSync(path.join(outDir, name), createPdfBuffer(lines));
}
console.log(`Generated ${Object.keys(SAMPLES).length} sample resumes in uploads/`);
