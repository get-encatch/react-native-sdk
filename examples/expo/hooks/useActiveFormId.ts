import { useMemo, useState } from 'react';
import { resolveSelectedFormId } from '@/constants/formIds';
import { mergeEnvFormIds, useTesterConfig } from '@/contexts/TesterConfigContext';

/** Resolves the active feedback configuration id from env suggestions + manual input. */
export function useActiveFormId(initialOverride?: string) {
  const { formId: defaultFormId } = useTesterConfig();
  const suggestedIds = useMemo(() => mergeEnvFormIds(defaultFormId), [defaultFormId]);
  const [manualFormId, setManualFormId] = useState(initialOverride ?? defaultFormId);
  const [selectedFormId, setSelectedFormId] = useState(defaultFormId);

  const activeFormId = useMemo(
    () => resolveSelectedFormId(suggestedIds, selectedFormId || manualFormId || defaultFormId),
    [defaultFormId, manualFormId, selectedFormId, suggestedIds]
  );

  return {
    suggestedIds,
    manualFormId,
    setManualFormId,
    selectedFormId,
    setSelectedFormId,
    activeFormId,
  };
}
