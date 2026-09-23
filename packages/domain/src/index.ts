/** Superfície pública do pacote. Import cruzado passa por aqui. */
export * from './rmStudentSource';
export * from './sourceId';
export * from './studentTransformer';
export * from './payloadHash';
export * from './yearGroupResolver';
export * from './studentEnrichment';
export * from './rmAttendanceTargets';
export * from './periodTimeIndex';
export * from './attendanceProjection';
export * from './frequenciaXml';
export * from './rmAttendanceSource';
export * from './rmGuardianSource';
export * from './rmGradeSource';
export * from './toddleGradeSource';
export * from './gradeProjection';
export * from './rmGradeTargets';
export * from './toddleAssessmentSource';
export {
  decimalParaRm,
  montaXmlProva,
  montaLotesNotasAvaliacao,
  chaveNaturalNotaAvaliacao,
  type ProvaParaCriar,
  type NotaParaEscrever,
  type LoteNotasAvaliacao,
} from './provaXml';
export * from './rmAssessmentTargets';
export * from './assessmentProjection';
export * from './notaXml';
export * from './rmTeacherSource';
export * from './chaveCourse';
export * from './notaCanonica';
export * from './resolvedorCourse';
export * from './rmWriteDecision';
export * from './volumeGuard';
