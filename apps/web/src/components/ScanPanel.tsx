import React, { useRef, useState } from 'react';
import { Camera, FileText, Images, ScanLine, Upload, X, AlertCircle } from 'lucide-react';

interface ScanPanelProps {
  busyLabel: string | null;
  onImportDocument: (file: File) => void;
  onImagesToPdf: (files: File[]) => void;
  onCancel: () => void;
}

export default function ScanPanel({
  busyLabel,
  onImportDocument,
  onImagesToPdf,
  onCancel,
}: ScanPanelProps) {
  const docInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeMenu, setActiveMenu] = useState<'main' | 'scanText' | 'photoPdf'>('main');

  const disabled = !!busyLabel;

  const handleDocumentChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = firstInputFile(event.currentTarget);
    event.target.value = '';
    setError(null);
    if (!file) return;
    onImportDocument(file);
  };

  const handleImagesChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = inputFiles(event.currentTarget);
    event.target.value = '';
    setError(null);
    if (files.length === 0) return;
    if (files.some((file) => !file.type.startsWith('image/'))) {
      setError('Choose image files only.');
      return;
    }
    onImagesToPdf(files);
  };

  const handleCameraChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = firstInputFile(event.currentTarget);
    event.target.value = '';
    setError(null);
    if (!file) return;
    if (activeMenu === 'scanText') {
      onImportDocument(file);
    } else {
      onImagesToPdf([file]);
    }
  };

  const handleLibraryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = inputFiles(event.currentTarget);
    event.target.value = '';
    setError(null);
    if (files.length === 0) return;
    if (files.some((file) => !file.type.startsWith('image/'))) {
      setError('Choose image files only.');
      return;
    }
    if (activeMenu === 'scanText') {
      onImportDocument(files[0]);
    } else {
      onImagesToPdf(files);
    }
  };

  return (
    <div className="owll-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif' }}>Scan text</div>
          <div style={{ fontSize: 13, color: '#8C8684', fontFamily: 'Titillium Web, sans-serif' }}>Images, PDF, DOCX, TXT</div>
        </div>
        <button
          onClick={onCancel}
          disabled={disabled}
          style={{ background: 'transparent', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', color: '#8C8684', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 }}
          aria-label="Close"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <input
        ref={docInputRef}
        type="file"
        accept="image/*,.pdf,.docx,.doc,.txt,.md,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*"
        style={{ display: 'none' }}
        onChange={handleDocumentChange}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleImagesChange}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handleCameraChange}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        multiple={activeMenu === 'photoPdf'}
        style={{ display: 'none' }}
        onChange={handleLibraryChange}
      />

      {activeMenu === 'main' ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <ActionButton
            icon={<ScanLine size={17} />}
            title="Scan image to text"
            subtitle="Camera or photo library"
            disabled={disabled}
            onClick={() => setActiveMenu('scanText')}
          />
          <ActionButton
            icon={<Upload size={17} />}
            title="Read document text"
            subtitle="PDF, DOCX, TXT, image"
            disabled={disabled}
            onClick={() => docInputRef.current?.click()}
          />
          <ActionButton
            icon={<Camera size={17} />}
            title="Photo to PDF"
            subtitle="Take one scan and save"
            disabled={disabled}
            onClick={() => setActiveMenu('photoPdf')}
          />
          <ActionButton
            icon={<Images size={17} />}
            title="Images to PDF"
            subtitle="Pick one or more pages"
            disabled={disabled}
            onClick={() => imageInputRef.current?.click()}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            onClick={() => setActiveMenu('main')}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#8C8684', cursor: 'pointer', padding: 0, marginBottom: 8, fontSize: 13, fontFamily: 'Titillium Web, sans-serif' }}
          >
            &lt; Back to options
          </button>
          <ActionButton
            icon={<Camera size={17} />}
            title="Take Photo"
            subtitle="Use your camera"
            disabled={disabled}
            onClick={() => cameraInputRef.current?.click()}
          />
          <ActionButton
            icon={<Images size={17} />}
            title="Choose from Library"
            subtitle="Pick an existing photo"
            disabled={disabled}
            onClick={() => libraryInputRef.current?.click()}
          />
        </div>
      )}

      {busyLabel && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#FFFFFF', fontSize: 12, fontFamily: 'Titillium Web, sans-serif' }}>
          <FileText size={14} />
          {busyLabel}
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#EF4444', fontFamily: 'Titillium Web, sans-serif' }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}
    </div>
  );
}

function inputFiles(input: HTMLInputElement): File[] {
  const files: File[] = [];
  for (let i = 0; i < (input.files?.length || 0); i += 1) {
    const file = input.files?.item(i);
    if (file) files.push(file);
  }
  return files;
}

function firstInputFile(input: HTMLInputElement): File | null {
  return input.files?.item(0) || null;
}

function ActionButton({
  icon,
  title,
  subtitle,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 13,
        borderRadius: 14,
        border: '1px solid rgba(78,78,78,0.42)',
        background: 'rgba(255,255,255,0.04)',
        color: '#FFFFFF',
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 12,
          color: '#FFFFFF',
          background: 'rgba(255,255,255,0.12)',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: 14 }}>{title}</span>
        <span style={{ display: 'block', color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: 12, marginTop: 2 }}>{subtitle}</span>
      </span>
    </button>
  );
}
