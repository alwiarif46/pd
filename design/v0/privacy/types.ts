export interface PrivacyPageProps {
  companyName: string
  policyUpdatedOn: string
  onBack: () => void
}

export interface PrivacySection {
  title: string
  body: string
}

export const PRIVACY_SECTIONS: PrivacySection[] = [
  { title: 'What we collect', body: 'We collect the account, bid, document, and usage information needed to provide Shaavir PD. We only collect what is necessary for proposal work.' },
  { title: 'How we use information', body: 'Your information is used to extract requirements, organize bid work, support your team, protect the service, and improve reliability. We do not sell your personal information.' },
  { title: 'AI processing and subprocessors', body: 'Documents may be processed by the AI model and subprocessors listed by your organization. Processing pauses when a file carries a marking that needs your approval.' },
  { title: 'Retention and deletion', body: 'You can delete bid files at any time. Resume text and evidence quotes are deleted 90 days after upload; candidate names and results remain.' },
  { title: 'Your choices', body: 'Organization owners can manage members and data settings. You may request access, correction, or deletion of personal information by contacting support.' },
]

export const SAMPLE_PRIVACY_PROPS: PrivacyPageProps = { companyName: 'Shaavir PD', policyUpdatedOn: 'October 14, 2026', onBack: () => undefined }

export default PrivacyPageProps
function PrivacyPage(_props: PrivacyPageProps) { return null }
