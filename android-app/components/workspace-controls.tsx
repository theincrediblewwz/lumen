import type { ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { colors, radii } from '@/theme/tokens';
export function WorkspaceButton({label,onPress,disabled=false,secondary=false}:{label:string;onPress:()=>void;disabled?:boolean;secondary?:boolean}) {
  return <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={({pressed})=>({minHeight:46,paddingHorizontal:16,paddingVertical:12,borderRadius:radii.medium,alignItems:'center',justifyContent:'center',backgroundColor:secondary?colors.graySoft:colors.ink,opacity:disabled?0.4:pressed?0.7:1})}><Text style={{color:secondary?colors.ink:colors.white,fontWeight:'700',fontSize:14}}>{label}</Text></Pressable>;
}
export function WorkspaceField({label,value,onChangeText,multiline=false}:{label:string;value:string;onChangeText:(value:string)=>void;multiline?:boolean}) {
  return <View style={{gap:8}}><Text style={{color:colors.inkMuted,fontSize:13}}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} multiline={multiline} textAlignVertical={multiline?'top':'center'} style={{color:colors.ink,backgroundColor:colors.surfaceStrong,borderWidth:1,borderColor:colors.line,borderRadius:radii.medium,minHeight:multiline?180:48,padding:14,fontSize:16,lineHeight:24}} /></View>;
}
export function WorkspaceCard({children}:{children:ReactNode}) { return <View style={{padding:16,gap:12,backgroundColor:colors.surfaceStrong,borderRadius:radii.large}}>{children}</View>; }
