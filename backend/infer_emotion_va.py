#!/usr/bin/env python3
"""Run EmotiEffLib's multitask face model on one image.

The enet_b0_8_va_mtl checkpoint produces eight emotion scores followed by
valence and arousal regression outputs.  This wrapper adds face detection and
returns a JSON result for every detected face.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from facenet_pytorch import MTCNN

from emotiefflib.facial_analysis import EmotiEffLibRecognizer


def softmax(values: np.ndarray) -> np.ndarray:
    values = values - np.max(values)
    exp_values = np.exp(values)
    return exp_values / exp_values.sum()


def predict_faces(face_images: list[np.ndarray], recognizer: Any) -> list[dict[str, Any]]:
    """Run the repository recognizer and expose emotion plus VA outputs."""
    if not face_images:
        return []

    emotions, raw_scores = recognizer.predict_emotions(face_images, logits=True)
    raw_scores = np.asarray(raw_scores, dtype=float)
    if raw_scores.ndim != 2 or raw_scores.shape[1] < 10:
        raise RuntimeError(
            "Expected at least 10 outputs from enet_b0_8_va_mtl "
            f"(8 emotion + valence + arousal), got {raw_scores.shape}."
        )

    predictions = []
    for emotion, scores in zip(emotions, raw_scores):
        emotion_scores = softmax(scores[:8])
        predictions.append(
            {
                "emotion": str(emotion),
                "emotion_scores": emotion_scores,
                "confidence": float(np.max(emotion_scores)),
                "valence": float(scores[-2]),
                "arousal": float(scores[-1]),
            }
        )
    return predictions


def detect_faces(image_rgb: np.ndarray, device: str, threshold: float) -> list[np.ndarray]:
    detector = MTCNN(keep_all=True, post_process=False, min_face_size=40, device=device)
    boxes, probabilities = detector.detect(image_rgb)
    if boxes is None or probabilities is None:
        return []

    height, width = image_rgb.shape[:2]
    faces: list[np.ndarray] = []
    for box, probability in zip(boxes, probabilities):
        if probability is None or probability < threshold:
            continue
        x1, y1, x2, y2 = np.rint(np.asarray(box, dtype=np.float32)).astype(int)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(width, x2), min(height, y2)
        if x2 > x1 and y2 > y1:
            faces.append(image_rgb[y1:y2, x1:x2])
    return faces


def infer(image_path: Path, device: str, detection_threshold: float) -> dict[str, Any]:
    image_bgr = cv2.imread(str(image_path))
    if image_bgr is None:
        raise ValueError(f"Could not read image: {image_path}")
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    faces = detect_faces(image_rgb, device, detection_threshold)
    if not faces:
        return {"image": str(image_path), "faces": []}

    recognizer = EmotiEffLibRecognizer(
        engine="torch",
        model_name="enet_b0_8_va_mtl",
        device=device,
    )
    emotions, raw_scores = recognizer.predict_emotions(faces, logits=True)
    raw_scores = np.asarray(raw_scores)
    if raw_scores.ndim != 2 or raw_scores.shape[1] < 10:
        raise RuntimeError(
            "Expected at least 10 outputs from enet_b0_8_va_mtl "
            f"(8 emotion + valence + arousal), got {raw_scores.shape}."
        )

    results = []
    for emotion, scores in zip(emotions, raw_scores):
        emotion_probabilities = softmax(scores[:8])
        results.append(
            {
                "emotion": emotion,
                "emotion_confidence": float(np.max(emotion_probabilities)),
                "valence": float(scores[-2]),
                "arousal": float(scores[-1]),
            }
        )
    return {"image": str(image_path), "faces": results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Image containing one or more faces")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--detection-threshold", type=float, default=0.90)
    args = parser.parse_args()

    if args.device == "cuda":
        try:
            import torch

            if not torch.cuda.is_available():
                raise RuntimeError("CUDA was requested but is not available")
        except ImportError as error:
            raise RuntimeError("CUDA inference requires PyTorch") from error

    print(json.dumps(infer(args.image, args.device, args.detection_threshold), indent=2))


if __name__ == "__main__":
    main()
