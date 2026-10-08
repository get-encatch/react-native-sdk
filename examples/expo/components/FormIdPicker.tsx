import { StyleSheet, TextInput, View } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { Text } from '@/components/Themed';

type FormIdPickerProps = {
  formIds: readonly string[];
  value: string;
  onChange: (formId: string) => void;
  textColor: string;
  borderColor: string;
  placeholderColor: string;
  /** Shown when the manual text field is empty. */
  emptyHint?: string;
  /** Label for the manual input when env ids exist. */
  manualLabel?: string;
};

export function FormIdPicker({
  formIds,
  value,
  onChange,
  textColor,
  borderColor,
  placeholderColor,
  emptyHint = 'Enter feedback configuration ID',
  manualLabel = 'Feedback configuration ID',
}: FormIdPickerProps) {
  return (
    <>
      {formIds.length > 1 ? (
        <>
          <Text style={[styles.hint, { color: placeholderColor }]}>
            Pick from EXPO_PUBLIC_ENCATCH_FORM_ID or edit below
          </Text>
          <View style={[styles.pickerWrap, { borderColor }]}>
            <Picker
              selectedValue={value || formIds[0]}
              onValueChange={(itemValue) => onChange(String(itemValue))}
              style={[styles.picker, { color: textColor }]}
              dropdownIconColor={textColor}>
              {formIds.map((id) => (
                <Picker.Item key={id} label={id} value={id} />
              ))}
            </Picker>
          </View>
        </>
      ) : formIds.length === 0 ? (
        <Text style={[styles.hint, { color: placeholderColor }]}>{emptyHint}</Text>
      ) : null}

      <Text style={[styles.manualLabel, { color: placeholderColor }]}>{manualLabel}</Text>
      <TextInput
        style={[styles.input, { color: textColor, borderColor }]}
        placeholder="Feedback configuration ID"
        placeholderTextColor={placeholderColor}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </>
  );
}

const styles = StyleSheet.create({
  hint: {
    fontSize: 12,
    marginBottom: 8,
    alignSelf: 'stretch',
  },
  manualLabel: {
    fontSize: 12,
    marginBottom: 8,
    alignSelf: 'stretch',
    fontWeight: '600',
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 16,
    width: '100%',
  },
  pickerWrap: {
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
    width: '100%',
  },
  picker: {
    width: '100%',
  },
});
