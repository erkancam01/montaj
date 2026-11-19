// Sahne Z-yukarı: tüm Object3D'ler (kameralar dahil) için varsayılan "yukarı" ekseni.
// Bu dosya main.tsx'te İLK import olmalı.
import { Object3D } from 'three';

Object3D.DEFAULT_UP.set(0, 0, 1);
