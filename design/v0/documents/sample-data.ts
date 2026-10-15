import type { Doc, UploadNotice, UploadProgress } from './types'
export const documentSamples: Doc[] = [
 { id:'d1',name:'Solicitation.pdf',kind:'solicitation',amendmentNo:null,pages:86,pagesEstimated:false,sizeBytes:72000000,uploadedAt:'2026-08-01T12:00:00Z',liveUntil:'2026-11-03',status:{state:'live'},marking:{state:'none'},keyCheck:'ok' },
 { id:'d2',name:'Amendment 1.pdf',kind:'amendment',amendmentNo:1,pages:4,pagesEstimated:false,sizeBytes:4200000,uploadedAt:'2026-08-12T12:00:00Z',liveUntil:'2026-11-03',status:{state:'processing',queuePosition:2},marking:{state:'none'},keyCheck:'mismatch' },
 { id:'d3',name:'Attachment A.docx',kind:'attachment',amendmentNo:null,pages:40,pagesEstimated:true,sizeBytes:12000000,uploadedAt:'2026-08-13T12:00:00Z',liveUntil:'2026-11-03',status:{state:'archived'},marking:{state:'none'},keyCheck:'not_applicable' },
 { id:'d4',name:'Dana Reyes resume.pdf',kind:'resume',amendmentNo:null,pages:3,pagesEstimated:false,sizeBytes:1200000,uploadedAt:'2026-08-14T12:00:00Z',liveUntil:null,status:{state:'deleted'},marking:{state:'none'},keyCheck:'not_applicable' },
 { id:'d5',name:'Draft volume 1.docx',kind:'draft',amendmentNo:null,pages:30,pagesEstimated:false,sizeBytes:34000000,uploadedAt:'2026-08-15T12:00:00Z',liveUntil:'2026-11-03',status:{state:'restored',until:'2026-11-20'},marking:{state:'confirmed',markings:['CUI']},keyCheck:'overridden' },
]
export const documentNotices: UploadNotice[] = [{id:'n1',fileName:'wrong.pdf',tone:'error',message:'This file belongs to a different solicitation. Start a new bid.'},{id:'n2',fileName:'duplicate.pdf',tone:'info',message:'Already uploaded.'},{id:'n3',fileName:'locked.pdf',tone:'error',message:'Upload an unlocked copy.'}]
export const documentUploads: UploadProgress[] = [{fileName:'new-attachment.pdf',percent:62}]
